import { BaseNotFoundError } from '../../../domain/errors.js';

const DEFAULT_BUDGET_MS = 600000; // soft time budget per call; override via config/env

function parseYearBase(req, res) {
  const { year, base } = req.body ?? {};
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: 'year must be an integer year (CE)' });
    return null;
  }
  if (!base || typeof base !== 'string') {
    res.status(400).json({ error: 'base is required' });
    return null;
  }
  return { year, base };
}

export class BaseController {
  constructor({ provisionYearBase, removeAllPartitions, budgetMs = DEFAULT_BUDGET_MS }) {
    this.provisionYearBase = provisionYearBase;
    this.removeAllPartitions = removeAllPartitions;
    this.budgetMs = budgetMs;
  }

  init = async (req, res, next) => {
    const input = parseYearBase(req, res);
    if (!input) return;
    try {
      const summary = await this.provisionYearBase.execute({
        gateway: req.larkGateway, base: input.base, year: input.year, budgetMs: this.budgetMs,
      });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof BaseNotFoundError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };

  removePartitions = async (req, res, next) => {
    const input = parseYearBase(req, res);
    if (!input) return;
    try {
      const summary = await this.removeAllPartitions.execute({
        gateway: req.larkGateway, base: input.base, year: input.year, budgetMs: this.budgetMs,
      });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof BaseNotFoundError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };
}
