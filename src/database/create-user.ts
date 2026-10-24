import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { isStrongPassword } from 'class-validator';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Creates one user account, or resets its password and role if the email exists, touching
// nothing else. A new deployment starts with an empty database: create the first admin with
// this, then each doctor or staff member. Unlike the demo seed, it is safe against production.
//
//   MONGODB_URI=... USER_EMAIL=... USER_PASSWORD=... USER_NAME="..." USER_ROLE=admin npm run create-user
//
// USER_ROLE: admin (default), doctor, nurse, pharmacist, lab or staff.
// Optional for doctors: USER_SPECIALTY, USER_DEPARTMENT.

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '', 10) || 12;

async function createUser() {
  const uri = process.env.MONGODB_URI;
  const email = process.env.USER_EMAIL?.trim().toLowerCase();
  const password = process.env.USER_PASSWORD ?? '';
  const role = (process.env.USER_ROLE?.trim().toLowerCase() || UserRole.ADMIN) as UserRole;

  if (!uri || !email || !password) {
    throw new Error('Set MONGODB_URI, USER_EMAIL and USER_PASSWORD (USER_NAME and USER_ROLE are optional).');
  }
  if (!Object.values(UserRole).includes(role)) {
    throw new Error(`USER_ROLE must be one of: ${Object.values(UserRole).join(', ')}.`);
  }
  // Same rule the API applies to new passwords (auth/dto/password-policy.ts).
  const strong = isStrongPassword(password, { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 });
  if (!strong || password.length > 72) {
    throw new Error('USER_PASSWORD must be 8-72 characters with upper and lower case letters, a number and a symbol.');
  }

  await mongoose.connect(uri);
  const users = mongoose.model(User.name, UserSchema);
  const existing = await users.exists({ email });
  await users.updateOne(
    { email },
    {
      $set: {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role,
        isActive: true,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      // A reset signs out every existing session of this account.
      $inc: { tokenVersion: 1 },
      $setOnInsert: {
        name: process.env.USER_NAME?.trim() || email,
        specialty: process.env.USER_SPECIALTY?.trim() ?? '',
        department: process.env.USER_DEPARTMENT?.trim() || (role === UserRole.ADMIN ? 'Administration' : ''),
      },
    },
    { upsert: true },
  );
  console.log(`${existing ? 'Updated' : 'Created'} ${role} ${email}.`);
}

createUser()
  .catch((err) => {
    console.error(`create-user failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
