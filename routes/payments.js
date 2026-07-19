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

const getPublicId = (file) => {
  if (!file) return null;
  return file.filename;
};

// @route   POST /api/payments/submit
// @desc    Submit proof of payment for a chit monthly contribution
// @access  Private
router.post('/submit', protect, upload.single('proof'), async (req, res) => {
  try {
    const { chitId, monthNumber, amount, transactionId } = req.body;

    if (!chitId || !monthNumber || !amount || !transactionId) {
      return res.status(400).json({ success: false, message: 'Please provide all payment details' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload payment receipt screenshot' });
    }

    const chit = await prisma.chit.findUnique({
      where: { id: chitId },
      include: { members: true }
    });
    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }

    const isApprovedMember = chit.members.some(
      (m) => m.userId === req.user.id && m.status === 'approved'
    );

    if (!isApprovedMember) {
      return res.status(403).json({ success: false, message: 'You are not an approved member of this chit fund' });
    }

    const existingPayment = await prisma.payment.findUnique({
      where: {
        userId_chitId_monthNumber: {
          userId: req.user.id,
          chitId: chitId,
          monthNumber: Number(monthNumber)
        }
      }
    });

    if (existingPayment) {
      // Allow resubmission when: rejected, edit_requested, or pending WITH an admin remark
      const canResubmit =
        existingPayment.status === 'rejected' ||
        existingPayment.status === 'edit_requested' ||
        (existingPayment.status === 'pending' && existingPayment.remarks && existingPayment.remarks.trim() !== '');

      if (canResubmit) {
        const updatedPayment = await prisma.payment.update({
          where: { id: existingPayment.id },
          data: {
            transactionId,
            amount: Number(amount),
            proofImgUrl: getFileUrl(req.file),
            proofPublicId: getPublicId(req.file),
            status: 'pending',
            remarks: ''
          }
        });
        return res.json({ success: true, message: 'Payment proof resubmitted successfully!', data: updatedPayment });
      }
      return res.status(400).json({
        success: false,
        message: `Payment proof for Month ${monthNumber} is already ${existingPayment.status}`,
      });
    }



    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        chitId: chitId,
        monthNumber: Number(monthNumber),
        amount: Number(amount),
        transactionId,
        proofImgUrl: getFileUrl(req.file),
        proofPublicId: getPublicId(req.file),
        status: 'pending',
      }
    });

    res.status(201).json({
      success: true,
      message: 'Payment proof submitted. Admin will verify shortly.',
      data: payment,
    });
  } catch (error) {
    console.error('Error submitting payment:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error submitting payment proof' });
  }
});

// @route   GET /api/payments/my-payments
// @desc    Get current user's payments
// @access  Private
router.get('/my-payments', protect, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { userId: req.user.id },
      include: { chit: { select: { name: true, chitValue: true, monthlyContribution: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ success: false, message: 'Server error fetching payments' });
  }
});

// @route   GET /api/payments/pending
// @desc    Get all pending payments for admin review
// @access  Private/Staff
router.get('/pending', protect, staff, async (req, res) => {
  try {
    const isEmp = req.user.role === 'employee';

    const payments = await prisma.payment.findMany({
      where: { 
        status: 'pending',
        ...(isEmp ? { chit: { createdBy: req.user.id } } : {})
      },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        chit: { select: { name: true, chitValue: true, monthlyContribution: true, currentMonth: true, createdBy: true } }
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    res.status(500).json({ success: false, message: 'Server error fetching pending payments' });
  }
});

// @route   POST /api/payments/:id/verify
// @desc    Approve or reject user payment proof
// @access  Private/Staff
router.post('/:id/verify', protect, staff, async (req, res) => {
  try {
    const { status, remarks } = req.body; // status: 'approved' | 'rejected'

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Please provide status approved or rejected' });
    }

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
        status,
        remarks: remarks || '',
        verifiedAt: new Date()
      }
    });

    if (status === 'approved') {
      const chit = await prisma.chit.findUnique({
        where: { id: payment.chitId },
        include: { members: true }
      });
      if (chit) {
        const approvedMembers = chit.members.filter((m) => m.status === 'approved');
        const totalApprovedMembersCount = approvedMembers.length;

        const paymentsForMonth = await prisma.payment.count({
          where: {
            chitId: chit.id,
            monthNumber: chit.currentMonth,
            status: 'approved',
          }
        });

        if (paymentsForMonth >= totalApprovedMembersCount && totalApprovedMembersCount > 0) {
          const newStatus = chit.currentMonth >= chit.durationMonths ? 'completed' : chit.status;
          const newMonth = chit.currentMonth >= chit.durationMonths ? chit.currentMonth : chit.currentMonth + 1;
          
          await prisma.chit.update({
            where: { id: chit.id },
            data: { status: newStatus, currentMonth: newMonth }
          });
        }
      }
    }

    res.json({
      success: true,
      message: `Payment status updated to ${status}.`,
      data: updatedPayment,
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Server error verifying payment' });
  }
});

module.exports = router;
