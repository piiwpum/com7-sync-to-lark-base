# service

Node.js + Express + Redis REST API built with **clean architecture**.

## Architecture

```
src/
├── domain/                     # Enterprise business rules (no dependencies)
│   ├── entities/User.js        #   entities + domain errors
│   └── repositories/           #   repository ports (interfaces)
├── application/                # Application business rules
│   └── use-cases/user/         #   CreateUser, GetUser, ListUsers, DeleteUser
├── infrastructure/             # Frameworks & drivers (implementation details)
│   ├── config/env.js           #   env loading
│   ├── database/redisClient.js #   Redis connection
│   ├── repositories/           #   RedisUserRepository (adapter)
│   └── web/                    #   Express app, routes, controllers, middleware
└── index.js                    # Composition root (dependency injection)
```

**Dependency rule:** dependencies point inward. `domain` knows nothing about
Express or Redis; use-cases depend only on the repository *port*; the concrete
Redis adapter is injected at the composition root (`index.js`). Swapping Redis
for Postgres means writing one new repository — no domain/use-case changes.

## Getting started

```bash
# 1. Install deps
npm install

# 2. Start a local Redis (Docker)
npm run redis:up          # or: docker compose up -d redis

# 3. Configure env
cp .env.example .env

# 4. Run
npm run dev               # watch mode
# npm start               # production
```

> No Docker? Install Redis locally (`brew install redis && brew services start redis`)
> and keep `REDIS_URL=redis://localhost:6379`.

## API

| Method | Path             | Description       |
|--------|------------------|-------------------|
| GET    | `/health`        | Health check      |
| POST   | `/api/users`     | Create a user     |
| GET    | `/api/users`     | List users        |
| GET    | `/api/users/:id` | Get user by id    |
| DELETE | `/api/users/:id` | Delete a user     |

### Examples

```bash
# Create
curl -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com"}'

# List
curl http://localhost:3000/api/users

# Get one
curl http://localhost:3000/api/users/<id>

# Delete
curl -X DELETE http://localhost:3000/api/users/<id>
```
