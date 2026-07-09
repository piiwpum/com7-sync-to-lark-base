/**
 * Clear one year's DATA — the shared destructive core of hard-full-sync and
 * clear-partitions. Empties every partition table on Lark (deletes the ids we
 * know from sync_mapping, then sweeps whatever remains via listRecordIds to
 * catch orphans), checkpointing per partition so a crash resumes mid-clear;
 * then wipes the ops side for the year (mapping rows + partition fill_counts/
 * boundaries) and resets the full_sync checkpoint so any later backfill starts
 * from scratch. Deliberately KEEPS the Lark tables and their manual formulas —
 * only records are deleted.
 *
 * This does NOT re-populate: hard-full-sync enqueues a full_sync afterwards,
 * clear-partitions stops here. `scope` is the caller's own resume checkpoint
 * (e.g. `hard_full:2026` vs `clear_partitions:2026`) so the two jobs never
 * clobber each other's progress.
 */
export async function clearYear({
  year, scope, appId, appSecret,
  yearRepository, mappingRepository, tokenCache, createGateway, baseDomain,
  deleteChunkSize = 500,
}) {
  const { baseId } = await yearRepository.getYear(year);
  const state = await mappingRepository.getState(scope);
  const fromPartition = state?.checkpoint ?? 0; // partitions <= this are already cleared

  const partitions = await mappingRepository.listPartitions({ year });
  for (const p of partitions) {
    if (p.partitionNo <= fromPartition) continue;

    // A fresh token per partition — the clear can run for a long time.
    const token = await tokenCache.getToken(appId, appSecret);
    const gateway = createGateway({ token, baseDomain });

    // (a) delete the records we have mapped (bulk, no Lark read needed)…
    const mapped = await mappingRepository.getMappingsForPartition({ year, partitionNo: p.partitionNo });
    await deleteAll(gateway, baseId, p.larkTableId, mapped.map((m) => m.larkRecordId), deleteChunkSize);
    // …(b) then sweep anything still on the table (orphans mapping didn't know about).
    const remaining = await gateway.listRecordIds({ baseId, tableId: p.larkTableId });
    await deleteAll(gateway, baseId, p.larkTableId, remaining, deleteChunkSize);

    await mappingRepository.setState(scope, { checkpoint: p.partitionNo });
  }

  // Lark tables are empty — wipe the ops side (records only; tables stay).
  await mappingRepository.clearYearMappings({ year });
  await mappingRepository.resetPartitionsForYear({ year });
  // Reset the backfill checkpoint so a future full_sync starts from scratch
  // (clearState, not setState — setState COALESCEs and can't null a field).
  await mappingRepository.clearState({ scope: `full_sync:${year}` });
}

// Delete record ids in batches of deleteChunkSize; never call batchDelete
// with an empty list.
async function deleteAll(gateway, baseId, tableId, recordIds, deleteChunkSize) {
  for (let i = 0; i < recordIds.length; i += deleteChunkSize) {
    const ids = recordIds.slice(i, i + deleteChunkSize);
    if (ids.length === 0) continue;
    await gateway.batchDelete({ baseId, tableId, recordIds: ids });
  }
}
