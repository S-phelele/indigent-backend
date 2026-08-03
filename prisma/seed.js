const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash('admin123', 12);
  const applicantPassword = await bcrypt.hash('applicant123', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@indigent.gov.za' },
    update: {},
    create: {
      email: 'admin@indigent.gov.za',
      password: adminPassword,
      firstName: 'System',
      lastName: 'Admin',
      role: 'ADMIN',
      isVerified: true,
    },
  });

  const applicant = await prisma.user.upsert({
    where: { email: 'john.doe@example.com' },
    update: {},
    create: {
      email: 'john.doe@example.com',
      password: applicantPassword,
      firstName: 'John',
      lastName: 'Doe',
      cellNumber: '0815912000',
      idNumber: '9012291111111',
      role: 'APPLICANT',
      isVerified: true,
    },
  });

  console.log('Seeded users:');
  console.log('  Admin: admin@indigent.gov.za / admin123');
  console.log('  Applicant: john.doe@example.com / applicant123');
  console.log({ adminId: admin.id, applicantId: applicant.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
