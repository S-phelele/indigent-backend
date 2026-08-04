Indigent Backend

Tech Stack
```bash
Backend	Node.js, Express, Prisma, PostgreSQL
Auth	JWT + OTP (SMS simulated)
```

Project Structure
```
├── backend/                 # Express API
   ├── prisma/
   │   ├── schema.prisma
   │   └── seed.js
   ├── src/
   │   ├── index.js
   │   ├── middleware/auth.js
   │   └── routes/
   │       ├── auth.js
   │       ├── applications.js
   │       ├── admin.js
   │       └── documents.js
   ├── uploads/
   └── package.json

```
Prerequisites
Node.js 18+
PostgreSQL 14+
npm or yarn

Setup
1. Database
```bash
# Create database
createdb indigent_register

# Or via psql:
# CREATE DATABASE indigent_register;
```
2. Backend
```bash
cd backend
cp .env.example .env   # or use existing .env
# Edit DATABASE_URL if needed

npm install
npx prisma generate
npx prisma db push
npm run db:seed

npm run dev            # http://localhost:5000
```
