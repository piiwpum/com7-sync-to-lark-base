/**
 * Thin HTTP adapter: translates requests into use-case calls and
 * use-case results into HTTP responses. No business logic here.
 */
export class UserController {
  constructor({ createUser, getUser, listUsers, deleteUser }) {
    this.createUser = createUser;
    this.getUser = getUser;
    this.listUsers = listUsers;
    this.deleteUser = deleteUser;
  }

  create = async (req, res, next) => {
    try {
      const { name, email } = req.body ?? {};
      const user = await this.createUser.execute({ name, email });
      res.status(201).json(user.toJSON());
    } catch (err) {
      next(err);
    }
  };

  getById = async (req, res, next) => {
    try {
      const user = await this.getUser.execute(req.params.id);
      res.json(user.toJSON());
    } catch (err) {
      next(err);
    }
  };

  list = async (_req, res, next) => {
    try {
      const users = await this.listUsers.execute();
      res.json(users.map((u) => u.toJSON()));
    } catch (err) {
      next(err);
    }
  };

  remove = async (req, res, next) => {
    try {
      await this.deleteUser.execute(req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
