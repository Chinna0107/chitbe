const express = require('express');
const router = express.Router();
const { prisma } = require('../config/db');
const { protect, admin, staff } = require('../middleware/authMiddleware');
const { upload, isCloudinaryConfigured } = require('../config/cloudinary');

const getFileUrl = (file) => {
  if (!file) return null;
  if (isCloudinaryConfigured) {
    return file.path;
  } else {
    return `/uploads/${file.filename}`;
  }
};

// @route   GET /api/admin/users/pending
// @desc    Get all pending user registrations (not approved yet)
// @access  Private/Admin
router.get('/users/pending', protect, admin, async (req, res) => {
  try {
    const pendingUsers = await prisma.user.findMany({
      where: { isApproved: false, role: 'user' },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: pendingUsers });
  } catch (error) {
    console.error('Error fetching pending users:', error);
    res.status(500).json({ success: false, message: 'Server error fetching pending users' });
  }
});

// @route   POST /api/admin/users/:id/verify
// @desc    Approve or reject a user registration
// @access  Private/Admin
router.post('/users/:id/verify', protect, admin, async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action. Specify approve or reject.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (action === 'approve') {
      await prisma.user.update({
        where: { id: user.id },
        data: { isApproved: true }
      });
      return res.json({ success: true, message: `User ${user.name} approved successfully.` });
    } else {
      // Delete the proofs from Cloudinary / local storage
      const { deleteProof } = require('../config/cloudinary');
      
      if (user.aadharImgUrl) {
        await deleteProof(user.aadharImgUrl, user.aadharPublicId);
      }
      if (user.panImgUrl) {
        await deleteProof(user.panImgUrl, user.panPublicId);
      }

      await prisma.user.delete({ where: { id: user.id } });
      return res.json({ success: true, message: `User ${user.name} registration rejected and record removed.` });
    }
  } catch (error) {
    console.error('Error verifying user:', error);
    res.status(500).json({ success: false, message: 'Server error verifying user registration' });
  }
});

// @route   GET /api/admin/dashboard-stats
// @desc    Get metrics for admin dashboard
// @access  Private/Staff
router.get('/dashboard-stats', protect, staff, async (req, res) => {
  try {
    const isEmp = req.user.role === 'employee';
    const chitWhere = isEmp ? { createdBy: req.user.id } : {};

    const totalUsers = await prisma.user.count({ where: { role: 'user', isApproved: true } });
    const pendingApprovals = await prisma.user.count({ where: { role: 'user', isApproved: false } });
    const totalChits = await prisma.chit.count({ where: chitWhere });
    const activeChits = await prisma.chit.count({ where: { ...chitWhere, status: 'active' } });
    
    // Total revenue = sum of approved payments
    const payments = await prisma.payment.findMany({ 
      where: { 
        status: 'approved',
        ...(isEmp ? { chit: { createdBy: req.user.id } } : {})
      } 
    });
    const totalRevenue = payments.reduce((acc, curr) => acc + curr.amount, 0);
    const pendingPaymentsCount = await prisma.payment.count({ where: { status: 'pending' } });

    const upcomingChits = await prisma.chit.findMany({
      where: { ...chitWhere, status: 'upcoming' },
      include: { members: true }
    });
    
    const readyToActivateChitsCount = upcomingChits.filter(chit => {
      const approvedCount = chit.members.filter(m => m.status === 'approved').length;
      return approvedCount === chit.totalMembers && chit.totalMembers > 0;
    }).length;

    let pendingChitJoinsCount = 0;
    upcomingChits.forEach(chit => {
      pendingChitJoinsCount += chit.members.filter(m => m.status === 'pending').length;
    });

    res.json({
      success: true,
      data: {
        totalUsers,
        pendingApprovals,
        totalChits,
        activeChits,
        totalRevenue,
        pendingPaymentsCount,
        readyToActivateChitsCount,
        pendingChitJoinsCount,
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ success: false, message: 'Server error fetching dashboard stats' });
  }
});

// @route   GET /api/admin/users-records
// @desc    Get all user profiles and transaction history (chits & payments)
// @access  Private/Staff
router.get('/users-records', protect, staff, async (req, res) => {
  try {
    const isEmp = req.user.role === 'employee';
    
    let users = await prisma.user.findMany({
      where: { role: 'user' },
      orderBy: { createdAt: 'desc' }
    });
    const chits = await prisma.chit.findMany({
      where: isEmp ? { createdBy: req.user.id } : {},
      include: { members: { include: { user: true } } }
    });
    const payments = await prisma.payment.findMany({
      include: { chit: true }
    });

    if (isEmp) {
      // Employees only see users that are in their assigned chits
      const allowedUserIds = new Set();
      chits.forEach(chit => {
        chit.members.forEach(member => {
          if (member.userId) allowedUserIds.add(member.userId);
        });
      });
      users = users.filter(user => allowedUserIds.has(user.id));
    }

    const userRecords = users.map(user => {
      const joinedChits = chits.filter(chit => 
        chit.members.some(m => m.user && m.user.id === user.id && m.status === 'approved')
      ).map(chit => ({
        id: chit.id,
        name: chit.name,
        status: chit.status,
        currentMonth: chit.currentMonth,
        durationMonths: chit.durationMonths,
        monthlyContribution: chit.monthlyContribution,
        chitValue: chit.chitValue
      }));

      const userPayments = payments.filter(p => p.userId === user.id);

      return {
        user,
        chits: joinedChits,
        payments: userPayments
      };
    });

    res.json({ success: true, data: userRecords });
  } catch (error) {
    console.error('Error fetching users records:', error);
    res.status(500).json({ success: false, message: 'Server error fetching user records' });
  }
});

// @route   GET /api/admin/chits-records
// @desc    Get all chit pools and member details and installment history
// @access  Private/Staff
router.get('/chits-records', protect, staff, async (req, res) => {
  try {
    const isEmp = req.user.role === 'employee';
    const chits = await prisma.chit.findMany({
      where: isEmp ? { createdBy: req.user.id } : {},
      include: { 
        members: { include: { user: true } },
        creator: { select: { name: true, role: true } }
      }
    });
    const payments = await prisma.payment.findMany({
      include: { user: true }
    });
    
    const chitRecords = chits.map(chit => {
      const chitPayments = payments.filter(p => p.chitId === chit.id);
      return {
        chit,
        payments: chitPayments
      };
    });

    res.json({ success: true, data: chitRecords });
  } catch (error) {
    console.error('Error fetching chits records:', error);
    res.status(500).json({ success: false, message: 'Server error fetching chit records' });
  }
});

// @route   POST /api/admin/chits/:chitId/mark-paid
// @desc    Manually mark a user's payment for a specific month as paid
// @access  Private/Staff
router.post('/chits/:chitId/mark-paid', protect, staff, upload.single('proof'), async (req, res) => {
  try {
    const { chitId } = req.params;
    const { userId, monthNumber, amount, transactionId } = req.body;

    if (!userId || !monthNumber || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Verify chit and user exist
    const chit = await prisma.chit.findUnique({ where: { id: chitId } });
    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }
    
    if (req.user.role === 'employee' && chit.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized for this chit' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if payment already exists
    const existingPayment = await prisma.payment.findUnique({
      where: {
        userId_chitId_monthNumber: {
          userId,
          chitId,
          monthNumber: Number(monthNumber)
        }
      }
    });

    if (existingPayment) {
      return res.status(400).json({ success: false, message: 'Payment already recorded for this month.' });
    }

    let proofImgUrl = 'MANUAL_ENTRY';
    if (req.file) {
      proofImgUrl = getFileUrl(req.file);
    }

    // Create the manual payment record
    const payment = await prisma.payment.create({
      data: {
        userId,
        chitId,
        monthNumber: Number(monthNumber),
        amount: Number(amount),
        transactionId: transactionId || `MANUAL_${Date.now()}`,
        proofImgUrl,
        status: 'approved',
        remarks: 'Manually marked as paid by Admin',
        verifiedAt: new Date(),
      }
    });

    res.json({ success: true, message: 'Payment recorded successfully', data: payment });
  } catch (error) {
    console.error('Error marking payment as paid:', error);
    res.status(500).json({ success: false, message: 'Server error marking payment' });
  }
});

// @route   POST /api/admin/payments/:id/allow-edit
// @desc    Grant user permission to edit/resubmit their payment (sets status to edit_requested)
// @access  Private/Staff
router.post('/payments/:id/allow-edit', protect, staff, async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({ 
      where: { id: req.params.id },
      include: { chit: true }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    if (req.user.role === 'employee' && payment.chit.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized for this chit' });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot allow edit on a payment with status: ${payment.status}` });
    }

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'edit_requested',
        remarks: 'Admin has requested you to update your payment details and resubmit.'
      }
    });

    res.json({
      success: true,
      message: 'Edit access granted. User can now update and resubmit this payment.',
      data: updatedPayment
    });
  } catch (error) {
    console.error('Error allowing payment edit:', error);
    res.status(500).json({ success: false, message: 'Server error granting edit access' });
  }
});

// @route   POST /api/admin/payments/:id/mark-unpaid
// @desc    Reset an approved payment back to pending (mark as unpaid / unverified)
// @access  Private/Staff
router.post('/payments/:id/mark-unpaid', protect, staff, async (req, res) => {
  try {
    const { remarks } = req.body;

    const payment = await prisma.payment.findUnique({ 
      where: { id: req.params.id },
      include: { chit: true }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    if (req.user.role === 'employee' && payment.chit.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized for this chit' });
    }

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'edit_requested',
        remarks: remarks || 'Marked as unpaid by Admin. Please update your transaction ID and re-upload the payment screenshot.',
        verifiedAt: null
      }
    });

    res.json({
      success: true,
      message: 'Payment has been marked as unpaid and returned to verification queue.',
      data: updatedPayment
    });
  } catch (error) {
    console.error('Error marking payment as unpaid:', error);
    res.status(500).json({ success: false, message: 'Server error marking payment as unpaid' });
  }
});

// ==========================================
// EMPLOYEE (STAFF) MANAGEMENT ROUTES
// ==========================================

// @route   GET /api/admin/employees
// @desc    Get all employees
// @access  Private/Admin
router.get('/employees', protect, admin, async (req, res) => {
  try {
    const employees = await prisma.user.findMany({
      where: { role: 'employee' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        createdChits: {
          select: { id: true, name: true, status: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: employees });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ success: false, message: 'Server error fetching employees' });
  }
});

// @route   POST /api/admin/employees
// @desc    Create a new employee account
// @access  Private/Admin
router.post('/employees', protect, admin, async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Please provide all fields' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }

    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const employee = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword,
        role: 'employee',
        isApproved: true, // Employees are auto-approved
      },
      select: { id: true, name: true, email: true, role: true }
    });

    res.status(201).json({ success: true, message: 'Employee created successfully', data: employee });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({ success: false, message: 'Server error creating employee' });
  }
});

// @route   DELETE /api/admin/employees/:id
// @desc    Delete an employee account
// @access  Private/Admin
router.delete('/employees/:id', protect, admin, async (req, res) => {
  try {
    const employee = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!employee || employee.role !== 'employee') {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ success: false, message: 'Server error deleting employee' });
  }
});

// @route   PUT /api/admin/chits/:chitId/assign
// @desc    Assign a chit to an employee
// @access  Private/Admin
router.put('/chits/:chitId/assign', protect, admin, async (req, res) => {
  try {
    const { employeeId } = req.body; // Can be null to unassign
    
    if (employeeId) {
      const employee = await prisma.user.findUnique({ where: { id: employeeId } });
      if (!employee || employee.role !== 'employee') {
        return res.status(400).json({ success: false, message: 'Invalid employee ID' });
      }
    }

    const chit = await prisma.chit.update({
      where: { id: req.params.chitId },
      data: { createdBy: employeeId || null },
      include: { creator: { select: { id: true, name: true } } }
    });

    res.json({ 
      success: true, 
      message: employeeId ? `Chit assigned to ${chit.creator.name}` : 'Chit unassigned',
      data: chit 
    });
  } catch (error) {
    console.error('Error assigning chit:', error);
    res.status(500).json({ success: false, message: 'Server error assigning chit' });
  }
});

module.exports = router;

