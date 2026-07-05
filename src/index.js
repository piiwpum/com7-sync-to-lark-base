import { config } from './infrastructure/config/env.js';
import { createApp } from './infrastructure/web/app.js';
import { createOpsPool } from './infrastructure/database/opsPool.js';
import { createTokenCache } from './infrastructure/lark/tokenCache.js';
import { createLarkGateway } from './infrastructure/lark/LarkGatewayHttp.js';
import { larkAuth as makeLarkAuth } from './infrastructure/web/middlewares/larkAuth.js';
import { ProvisionYearBase } from './application/use-cases/ProvisionYearBase.js';
import { RemoveAllPartitions } from './application/use-cases/RemoveAllPartitions.js';
import { GetBaseStatus } from './application/use-cases/GetBaseStatus.js';
import { BaseController } from './infrastructure/web/controllers/BaseController.js';
import { ITEC_FIELD_SCHEMA } from './infrastructure/config/itecFieldSchema.js';
import { PARTITION_COUNT, partitionName, parsePartitionNo } from './domain/services/partition.js';
import { createYearRepository } from './infrastructure/database/YearRepositoryMysql.js';
import { EnqueueFullSync } from './application/use-cases/EnqueueFullSync.js';
import { GetFullSyncStatus } from './application/use-cases/GetFullSyncStatus.js';
import { SyncController } from './infrastructure/web/controllers/SyncController.js';
import { createJobQueue } from './infrastructure/database/JobQueueMysql.js';
import { createMappingRepository } from './infrastructure/database/MappingRepositoryMysql.js';

/**
 * Composition root — the ONLY place that wires concrete implementations
 * (config → lark adapters → use-cases → controllers → web).
 *
 * Lark app credentials are supplied per-request via headers, so `larkAuth`
 * builds a request-scoped gateway; nothing Lark-secret lives here.
 */
async function bootstrap() {
  const opsPool = createOpsPool(config.opsDb);
  const yearRepository = createYearRepository(opsPool);
  const jobQueue = createJobQueue(opsPool);
  const mappingRepository = createMappingRepository(opsPool);

  const tokenCache = createTokenCache({ baseDomain: config.lark.baseDomain });
  const larkAuth = makeLarkAuth({
    tokenCache,
    createGateway: createLarkGateway,
    baseDomain: config.lark.baseDomain,
  });

  const provisionYearBase = new ProvisionYearBase({
    fieldSchema: ITEC_FIELD_SCHEMA,
    partitionCount: PARTITION_COUNT,
    partitionName,
    parsePartitionNo,
    yearRepository,
  });
  const removeAllPartitions = new RemoveAllPartitions({ parsePartitionNo, yearRepository });
  const getBaseStatus = new GetBaseStatus({ partitionCount: PARTITION_COUNT, yearRepository });
  const baseController = new BaseController({
    provisionYearBase, removeAllPartitions, getBaseStatus, budgetMs: config.baseInit.budgetMs,
  });

  const enqueueFullSync = new EnqueueFullSync({ yearRepository, jobQueue });
  const getFullSyncStatus = new GetFullSyncStatus({ jobQueue, mappingRepository });
  const syncController = new SyncController({ enqueueFullSync, getFullSyncStatus });

  const app = createApp({ larkAuth, baseController, opsPool, syncController });

  const server = app.listen(config.port, () => {
    console.log(`[http] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`\n[app] ${signal} received, shutting down...`);
    server.close(async () => {
      await opsPool.end();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[app] failed to start:', err);
  process.exit(1);
});
