import { YearNotProvisionedError } from '../../../domain/errors.js';

export class SyncController {
  constructor({ enqueueFullSync, getFullSyncStatus }) {
    this.enqueueFullSync = enqueueFullSync;
    this.getFullSyncStatus = getFullSyncStatus;
  }

  init = async (req, res, next) => {
    const year = req.body?.year;
    if (!Number.isInteger(year)) {
      return res.status(400).json({ error: 'year must be an integer year (CE)' });
    }
    try {
      const summary = await this.enqueueFullSync.execute({ year, appId: req.larkAppId, appSecret: req.larkAppSecret });
      res.status(202).json(summary);
    } catch (err) {
      if (err instanceof YearNotProvisionedError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };

  status = async (req, res, next) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year)) {
      return res.status(400).json({ error: 'year query param is required and must be an integer' });
    }
    try {
      const summary = await this.getFullSyncStatus.execute({ year });
      res.status(200).json(summary);
    } catch (err) {
      next(err);
    }
  };
}
