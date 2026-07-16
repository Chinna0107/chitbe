const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Load environment variables specifically for Cloudinary configuration fallback
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Ensure local uploads folder exists for fallback
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

let storage;
let isCloudinaryConfigured = false;

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'chitfund_proofs',
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
  });
  isCloudinaryConfigured = true;
  console.log('Cloudinary storage initialized.');
} else {
  console.log('Cloudinary environment variables missing. Falling back to local storage.');
  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

const deleteProof = async (imgUrl, publicId) => {
  if (!imgUrl) return;

  try {
    if (imgUrl.includes('cloudinary.com') && publicId) {
      if (isCloudinaryConfigured) {
        const result = await cloudinary.uploader.destroy(publicId);
        console.log(`Cloudinary file ${publicId} deleted:`, result);
        return result;
      } else {
        console.log(`Cannot delete Cloudinary file ${publicId}: Cloudinary not configured`);
      }
    } else {
      // Local file fallback
      const filename = publicId || path.basename(imgUrl);
      const filePath = path.join(__dirname, '../uploads', filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Local file ${filename} deleted.`);
      } else {
        console.log(`Local file ${filename} not found at ${filePath}.`);
      }
    }
  } catch (error) {
    console.error(`Error deleting proof (${imgUrl}):`, error);
  }
};

module.exports = {
  upload,
  isCloudinaryConfigured,
  cloudinary,
  deleteProof,
};
