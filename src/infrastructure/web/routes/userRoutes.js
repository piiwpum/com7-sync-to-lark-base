import { Router } from 'express';

export function userRoutes(userController) {
  const router = Router();

  router.post('/', userController.create);
  router.get('/', userController.list);
  router.get('/:id', userController.getById);
  router.delete('/:id', userController.remove);

  return router;
}
