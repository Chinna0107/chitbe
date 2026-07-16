const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { prisma } = require('../config/db');
const { protect } = require('../middleware/authMiddleware');
const { upload, isCloudinaryConfigured } = require('../config/cloudinary');

// Configure nodemailer transport
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'secretkey123', {
    expiresIn: '30d',
  });
};

const getFileUrl = (file) => {
  if (!file) return null;
  // Cloudinary storage sets file.path to the hosted URL.
  // Multer local storage sets file.filename.
  if (isCloudinaryConfigured) {
    return file.path;
  } else {
    return `/uploads/${file.filename}`;
  }
};

const getPublicId = (file) => {
  if (!file) return null;
  return file.filename;
};

// @route   POST /api/auth/register
// @desc    Register a new user with Aadhar and PAN uploads (requires approval to login)
// @access  Public
router.post(
  '/register',
  upload.fields([
    { name: 'aadhar', maxCount: 1 },
    { name: 'pan', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, email, password, phone } = req.body;

      // Basic validation
      if (!name || !email || !password || !phone) {
        return res.status(400).json({ success: false, message: 'Please enter all text fields' });
      }

      if (!req.files || !req.files.aadhar || !req.files.pan) {
        return res.status(400).json({
          success: false,
          message: 'Please upload both Aadhar and PAN card images',
        });
      }

      // Check if user already exists
      const userExists = await prisma.user.findUnique({ where: { email } });
      if (userExists) {
        return res.status(400).json({ success: false, message: 'User already exists with this email' });
      }

      const aadharFile = req.files.aadhar[0];
      const panFile = req.files.pan[0];

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Create new user (pending approval)
      const user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          phone,
          role: 'user', // Defaults to user. Superadmin can be created manually or seeded.
          isApproved: false,
          aadharImgUrl: getFileUrl(aadharFile),
          aadharPublicId: getPublicId(aadharFile),
          panImgUrl: getFileUrl(panFile),
          panPublicId: getPublicId(panFile),
        }
      });

      if (user) {
        res.status(201).json({
          success: true,
          message: 'Registration successful! Your account is pending Superadmin approval.',
        });
      } else {
        res.status(400).json({ success: false, message: 'Invalid user data' });
      }
    } catch (error) {
      console.error('Error during registration:', error);
      res.status(500).json({ success: false, message: error.message || 'Server error during registration' });
    }
  }
);

// @route   POST /api/auth/login
// @desc    Authenticate user & get token (only works if approved)
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please enter all fields' });
    }

    // Check for user
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Check if password matches
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Check if user is approved by superadmin
    if (!user.isApproved) {
      return res.status(403).json({
        success: false,
        message: 'Your registration has not been approved by the Superadmin yet. Please wait for authorization.',
      });
    }

    // Authentication successful
    res.json({
      success: true,
      token: generateToken(user.id),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isApproved: user.isApproved,
      },
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// @route   GET /api/auth/profile
// @desc    Get user profile
// @access  Private
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user) {
      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isApproved: user.isApproved,
          aadharImgUrl: user.aadharImgUrl,
          panImgUrl: user.panImgUrl,
        },
      });
    } else {
      res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error fetching profile' });
  }
});

// @route   POST /api/auth/request-otp
// @desc    Request Email OTP for login
// @access  Public
router.post('/request-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Please provide an email' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.isApproved) {
      return res.status(403).json({
        success: false,
        message: 'Your registration has not been approved by the Superadmin yet.',
      });
    }

    // Generate 6-digit OTP to match hor functionality
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save OTP to user
    await prisma.user.update({
      where: { email },
      data: { otp, otpExpires },
    });

    // Send email
    const mailOptions = {
      from: process.env.SMTP_EMAIL,
      to: email,
      subject: 'Your ChitFund Login OTP',
      text: `Your OTP for login is ${otp}. It is valid for 10 minutes.`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Error sending email:', error);
        return res.status(500).json({ success: false, message: 'Failed to send OTP email' });
      }
      res.json({ success: true, message: 'OTP sent successfully' });
    });
  } catch (error) {
    console.error('Error in request-otp:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify Email OTP and login
// @access  Public
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Please provide email and OTP' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.otp !== otp || !user.otpExpires || user.otpExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // Clear OTP
    await prisma.user.update({
      where: { email },
      data: { otp: null, otpExpires: null },
    });

    // Authentication successful
    res.json({
      success: true,
      token: generateToken(user.id),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isApproved: user.isApproved,
      },
    });
  } catch (error) {
    console.error('Error in verify-otp:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
