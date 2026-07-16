const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { connectDB, prisma } = require('./config/db');
const bcrypt = require('bcryptjs');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Connect to Database
connectDB();

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://santoshchitfunds.vercel.app'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve local upload files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chits', require('./routes/chits'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));

// Base Route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the ChitFund Management Platform API' });
});

// Seeding Default Superadmin on startup
const seedSuperadmin = async () => {
  try {
    const adminExists = await prisma.user.findFirst({ where: { role: 'superadmin' } });
    if (!adminExists) {
      console.log('Seeding default Superadmin account...');
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('adminpassword', salt);
      
      await prisma.user.create({
        data: {
          name: 'System Superadmin',
          email: 'admin@gmail.com',
          password: hashedPassword,
          phone: '9999999999',
          role: 'superadmin',
          isApproved: true,
          aadharImgUrl: 'https://res.cloudinary.com/demo/image/upload/v12345/mock-aadhar.png',
          aadharPublicId: 'mock-aadhar',
          panImgUrl: 'https://res.cloudinary.com/demo/image/upload/v12345/mock-pan.png',
          panPublicId: 'mock-pan',
        }
      });
      console.log('Superadmin seeded: admin@gmail.com / adminpassword');
    } else {
      console.log('Superadmin account already exists.');
    }
  } catch (error) {
    console.error('Error seeding Superadmin:', error);
  }
};

// Start Server after seeding
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await seedSuperadmin();
});
