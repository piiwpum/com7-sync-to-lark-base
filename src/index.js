import { config } from './infrastructure/config/env.js';
import { createApp } from './infrastructure/web/app.js';
import { createTokenCache } from './infrastructure/lark/tokenCache.js';
import { createLarkGateway } from './infrastructure/lark/LarkGatewayHttp.js';
import { larkAuth as makeLarkAuth } from './infrastructure/web/middlewares/larkAuth.js';
import { ProvisionYearBase } from './application/use-cases/ProvisionYearBase.js';
import { RemoveAllPartitions } from './application/use-cases/RemoveAllPartitions.js';
import { BaseController } from './infrastructure/web/controllers/BaseController.js';
import { ITEC_FIELD_SCHEMA } from './infrastructure/config/itecFieldSchema.js';
import { PARTITION_COUNT, partitionName, parsePartitionNo } from './domain/services/partition.js';

/**
 * Composition root — the ONLY place that wires concrete implementations
 * (config → lark adapters → use-cases → controllers → web).
 *
 * Lark app credentials are supplied per-request via headers, so `larkAuth`
 * builds a request-scoped gateway; nothing Lark-secret lives here.
 */
async function bootstrap() {
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
  });
  const removeAllPartitions = new RemoveAllPartitions({ parsePartitionNo });
  const baseController = new BaseController({
    provisionYearBase, removeAllPartitions, budgetMs: config.baseInit.budgetMs,
  });

  const app = createApp({ larkAuth, baseController });

  const server = app.listen(config.port, () => {
    console.log(`[http] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`\n[app] ${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[app] failed to start:', err);
  process.exit(1);
});
