import { YearNotProvisionedError, YearsNotProvisionedError } from '../../../domain/errors.js';

const DEFAULT_BUDGET_MS = 600000; // soft time budget per call; override via config/env

export class SyncController {
  constructor({ enqueueFullSync, getFullSyncStatus, checkFullSync, healFullSync, runIncrementalSync, enqueueHardFullSync, budgetMs = DEFAULT_BUDGET_MS }) {
    this.enqueueFullSync = enqueueFullSync;
    this.getFullSyncStatus = getFullSyncStatus;
    this.checkFullSync = checkFullSync;
    this.healFullSync = healFullSync;
    this.runIncrementalSync = runIncrementalSync;
    this.enqueueHardFullSync = enqueueHardFullSync;
    this.budgetMs = budgetMs;
  }

  // POST /sync/hard-full — DESTRUCTIVE: wipe a year's Lark records + ops mapping,
  // then re-backfill. Guarded by an explicit `confirm: true` in the body.
  hardFull = async (req, res, next) => {
    const year = req.body?.year;
    if (!Number.isInteger(year)) {
      return res.status(400).json({ error: 'year must be an integer year (CE)' });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'hard-full-sync deletes all records for the year; pass { "confirm": true } to proceed' });
    }
    try {
      const summary = await this.enqueueHardFullSync.execute({ year, appId: req.larkAppId, appSecret: req.larkAppSecret });
      res.status(202).json(summary);
    } catch (err) {
      if (err instanceof YearNotProvisionedError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };

  // POST /sync/incremental — one watermark-driven pass (new + changed rows from
  // itec ∪ daily_itec_temp). Runs synchronously; the watermark is the checkpoint.
  incremental = async (req, res, next) => {
    try {
      const summary = await this.runIncrementalSync.execute({ gateway: req.larkGateway });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof YearsNotProvisionedError) {
        return res.status(409).json({ error: err.message, years: err.years });
      }
      next(err);
    }
  };

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

  check = async (req, res, next) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year)) {
      return res.status(400).json({ error: 'year query param is required and must be an integer' });
    }
    try {
      const summary = await this.checkFullSync.execute({ gateway: req.larkGateway, year, budgetMs: this.budgetMs });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof YearNotProvisionedError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };

  heal = async (req, res, next) => {
    const year = req.body?.year;
    if (!Number.isInteger(year)) {
      return res.status(400).json({ error: 'year must be an integer year (CE)' });
    }
    try {
      const summary = await this.healFullSync.execute({ gateway: req.larkGateway, year, budgetMs: this.budgetMs });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof YearNotProvisionedError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };
}
