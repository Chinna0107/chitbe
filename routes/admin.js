const express = require('express');
const router = express.Router();
const { prisma } = require('../config/db');
const { protect, admin } = require('../middleware/authMiddleware');

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
// @access  Private/Admin
router.get('/dashboard-stats', protect, admin, async (req, res) => {
  try {
    const totalUsers = await prisma.user.count({ where: { role: 'user', isApproved: true } });
    const pendingApprovals = await prisma.user.count({ where: { role: 'user', isApproved: false } });
    const totalChits = await prisma.chit.count();
    const activeChits = await prisma.chit.count({ where: { status: 'active' } });
    
    // Total revenue = sum of approved payments
    const payments = await prisma.payment.findMany({ where: { status: 'approved' } });
    const totalRevenue = payments.reduce((acc, curr) => acc + curr.amount, 0);
    const pendingPaymentsCount = await prisma.payment.count({ where: { status: 'pending' } });

    const upcomingChits = await prisma.chit.findMany({
      where: { status: 'upcoming' },
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
// @access  Private/Admin
router.get('/users-records', protect, admin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: 'user' },
      orderBy: { createdAt: 'desc' }
    });
    const chits = await prisma.chit.findMany({
      include: { members: { include: { user: true } } }
    });
    const payments = await prisma.payment.findMany({
      include: { chit: true }
    });

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
// @access  Private/Admin
router.get('/chits-records', protect, admin, async (req, res) => {
  try {
    const chits = await prisma.chit.findMany({
      include: { members: { include: { user: true } } }
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
// @access  Private/Admin
router.post('/chits/:chitId/mark-paid', protect, admin, async (req, res) => {
  try {
    const { chitId } = req.params;
    const { userId, monthNumber, amount } = req.body;

    if (!userId || !monthNumber || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Verify chit and user exist
    const chit = await prisma.chit.findUnique({ where: { id: chitId } });
    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
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

    // Create the manual payment record
    const payment = await prisma.payment.create({
      data: {
        userId,
        chitId,
        monthNumber: Number(monthNumber),
        amount: Number(amount),
        transactionId: `MANUAL_${Date.now()}`,
        proofImgUrl: 'MANUAL_ENTRY',
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

module.exports = router;
