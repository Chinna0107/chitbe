const express = require('express');
const router = express.Router();
const { prisma } = require('../config/db');
const { protect, admin } = require('../middleware/authMiddleware');

// @route   POST /api/chits
// @desc    Create a new chit group
// @access  Private/Admin
router.post('/', protect, admin, async (req, res) => {
  try {
    const { name, totalMembers, chitValue, monthlyContribution, durationMonths, termsAndConditions } = req.body;

    if (!name || !totalMembers || !chitValue || !durationMonths) {
      return res.status(400).json({ success: false, message: 'Please enter all required fields' });
    }

    const finalMonthlyContribution = monthlyContribution 
      ? Number(monthlyContribution) 
      : Math.round(Number(chitValue) / Number(totalMembers));

    const chit = await prisma.chit.create({
      data: {
        name,
        totalMembers: Number(totalMembers),
        chitValue: Number(chitValue),
        monthlyContribution: finalMonthlyContribution,
        durationMonths: Number(durationMonths),
        termsAndConditions: termsAndConditions || "",
        status: 'upcoming',
      }
    });

    res.status(201).json({ success: true, data: chit });
  } catch (error) {
    console.error('Error creating chit:', error);
    res.status(500).json({ success: false, message: 'Server error creating chit' });
  }
});

// @route   GET /api/chits
// @desc    Get all chits (browse list)
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const chits = await prisma.chit.findMany({
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true }
            }
          }
        }
      }
    });
    res.json({ success: true, data: chits });
  } catch (error) {
    console.error('Error fetching chits:', error);
    res.status(500).json({ success: false, message: 'Server error fetching chits' });
  }
});

// @route   GET /api/chits/:id
// @desc    Get single chit details
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const chit = await prisma.chit.findUnique({
      where: { id: req.params.id },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true }
            }
          }
        }
      }
    });
    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }
    res.json({ success: true, data: chit });
  } catch (error) {
    console.error('Error fetching chit details:', error);
    res.status(500).json({ success: false, message: 'Server error fetching chit details' });
  }
});

// @route   POST /api/chits/:id/join
// @desc    Request to join a chit
// @access  Private
router.post('/:id/join', protect, async (req, res) => {
  try {
    const chit = await prisma.chit.findUnique({ 
      where: { id: req.params.id },
      include: { members: true }
    });

    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }

    if (chit.status !== 'upcoming') {
      return res.status(400).json({ success: false, message: 'This chit has already started or is completed' });
    }

    const isMember = chit.members.some(m => m.userId === req.user.id);
    if (isMember) {
      return res.status(400).json({ success: false, message: 'You have already requested or joined this chit' });
    }

    await prisma.chitMember.create({
      data: {
        chitId: chit.id,
        userId: req.user.id,
        status: 'pending'
      }
    });
    
    const updatedChit = await prisma.chit.findUnique({
      where: { id: chit.id },
      include: { members: true }
    });

    res.json({ success: true, message: 'Request to join submitted. Waiting for admin approval.', data: updatedChit });
  } catch (error) {
    console.error('Error joining chit:', error);
    res.status(500).json({ success: false, message: 'Server error joining chit' });
  }
});

// @route   POST /api/chits/:id/approve-member
// @desc    Approve or reject a member request to join a chit
// @access  Private/Admin
router.post('/:id/approve-member', protect, admin, async (req, res) => {
  try {
    const { userId, status } = req.body; // status: 'approved' or 'rejected'

    if (!userId || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Please provide valid userId and status' });
    }

    const chit = await prisma.chit.findUnique({ 
      where: { id: req.params.id },
      include: { members: true }
    });

    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }

    if (chit.status !== 'upcoming') {
      return res.status(400).json({ success: false, message: 'Chit is no longer in registration phase' });
    }

    const memberRecord = chit.members.find(m => m.userId === userId);
    if (!memberRecord) {
      return res.status(404).json({ success: false, message: 'Enrollment request not found for this user' });
    }

    const approvedCount = chit.members.filter(m => m.status === 'approved' && m.userId !== userId).length;

    if (status === 'approved' && approvedCount >= chit.totalMembers) {
      return res.status(400).json({ success: false, message: 'This chit is already full!' });
    }

    await prisma.chitMember.update({
      where: { id: memberRecord.id },
      data: { status }
    });

    const finalApprovedCount = status === 'approved' ? approvedCount + 1 : approvedCount;

    if (finalApprovedCount === chit.totalMembers) {
      await prisma.chitMember.updateMany({
        where: { chitId: chit.id, status: 'pending' },
        data: { status: 'rejected' }
      });
    }

    const finalChit = await prisma.chit.findUnique({
      where: { id: chit.id },
      include: { members: true }
    });

    res.json({
      success: true,
      message: `Member ${status} successfully.`,
      data: finalChit,
    });
  } catch (error) {
    console.error('Error approving/rejecting member:', error);
    res.status(500).json({ success: false, message: 'Server error processing member request' });
  }
});

// @route   POST /api/chits/:id/activate
// @desc    Manually activate/start a chit scheme when members list is complete
// @access  Private/Admin
router.post('/:id/activate', protect, admin, async (req, res) => {
  try {
    const chit = await prisma.chit.findUnique({ 
      where: { id: req.params.id },
      include: { members: true }
    });

    if (!chit) {
      return res.status(404).json({ success: false, message: 'Chit not found' });
    }

    if (chit.status !== 'upcoming') {
      return res.status(400).json({ success: false, message: 'This chit is already active or completed' });
    }

    const approvedCount = chit.members.filter(m => m.status === 'approved').length;

    if (approvedCount < chit.totalMembers) {
      return res.status(400).json({
        success: false,
        message: `Cannot activate. Chit has only ${approvedCount}/${chit.totalMembers} approved members.`,
      });
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + chit.durationMonths);

    const updatedChit = await prisma.chit.update({
      where: { id: chit.id },
      data: {
        status: 'active',
        startDate,
        endDate
      }
    });

    res.json({
      success: true,
      message: `Chit "${updatedChit.name}" has been successfully started and is now active!`,
      data: updatedChit,
    });
  } catch (error) {
    console.error('Error activating chit:', error);
    res.status(500).json({ success: false, message: 'Server error activating chit' });
  }
});

module.exports = router;
