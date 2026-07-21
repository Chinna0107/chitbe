const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('password123', 10);
  
  await prisma.user.updateMany({
    where: {
      email: {
        in: [
          'mockuser1784187255950_1@example.com',
          'mockuser1784187256543_2@example.com'
        ]
      }
    },
    data: {
      password: hash
    }
  });
  console.log("Successfully updated passwords to 'password123'");
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
