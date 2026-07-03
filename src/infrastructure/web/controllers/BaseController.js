import { BaseNotFoundError } from '../../../domain/errors.js';

const DEFAULT_BUDGET_MS = 120000; // soft time budget per call; override via config/env

export class BaseController {
  constructor({ provisionYearBase, budgetMs = DEFAULT_BUDGET_MS }) {
    this.provisionYearBase = provisionYearBase;
    this.budgetMs = budgetMs;
  }

  init = async (req, res, next) => {
    const { year, base } = req.body ?? {};
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'year must be an integer year (CE)' });
    }
    if (!base || typeof base !== 'string') {
      return res.status(400).json({ error: 'base is required' });
    }
    try {
      const summary = await this.provisionYearBase.execute({
        gateway: req.larkGateway, base, year, budgetMs: this.budgetMs,
      });
      res.status(200).json(summary);
    } catch (err) {
      if (err instanceof BaseNotFoundError) return res.status(404).json({ error: err.message });
      next(err);
    }
  };
}
