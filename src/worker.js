// src/worker.js
import { config } from './infrastructure/config/env.js';
import { createOpsPool } from './infrastructure/database/opsPool.js';
import { createCom7Pool } from './infrastructure/database/com7Pool.js';
import { createSourceRepository } from './infrastructure/database/SourceRepositoryMysql.js';
import { createMappingRepository } from './infrastructure/database/MappingRepositoryMysql.js';
import { createJobQueue } from './infrastructure/database/JobQueueMysql.js';
import { createYearRepository } from './infrastructure/database/YearRepositoryMysql.js';
import { createTokenCache } from './infrastructure/lark/tokenCache.js';
import { createLarkGateway } from './infrastructure/lark/LarkGatewayHttp.js';
import { RunFullSyncJob } from './application/use-cases/RunFullSyncJob.js';
import { ITEC_FIELD_SCHEMA } from './infrastructure/config/itecFieldSchema.js';

/**
 * Worker process composition root — separate entrypoint from src/index.js
 * (Express) because a full-sync job can run for hours, far longer than an
 * HTTP request's lifetime (spec §3).
 */
const POLL_INTERVAL_MS = 5000;

async function main() {
  const opsPool = createOpsPool(config.opsDb);
  const com7Pool = createCom7Pool(config.com7Db);

  const runFullSyncJob = new RunFullSyncJob({
    sourceRepository: createSourceRepository(com7Pool),
    mappingRepository: createMappingRepository(opsPool),
    yearRepository: createYearRepository(opsPool),
    jobQueue: createJobQueue(opsPool),
    tokenCache: createTokenCache({ baseDomain: config.lark.baseDomain }),
    createGateway: createLarkGateway,
    baseDomain: config.lark.baseDomain,
    fieldNames: ITEC_FIELD_SCHEMA.map((f) => f.name),
  });
  const jobQueue = createJobQueue(opsPool);

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; });
  process.on('SIGTERM', () => { shuttingDown = true; });

  console.log(`[worker] started, polling job_queue every ${POLL_INTERVAL_MS}ms`);

  while (!shuttingDown) {
    const jobs = await jobQueue.claim({ limit: 1 });
    if (jobs.length === 0) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    for (const job of jobs) {
      console.log(`[worker] running job ${job.id} (${job.type}, year=${job.year})`);
      try {
        await runFullSyncJob.execute(job);
        console.log(`[worker] job ${job.id} done`);
      } catch (err) {
        console.error(`[worker] job ${job.id} failed:`, err.message);
      }
    }
  }

  console.log('[worker] shutting down...');
  await opsPool.end();
  await com7Pool.end();
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
