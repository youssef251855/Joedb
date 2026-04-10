const fs = require('fs');
const path = require('path');

const structure = {
  'src/config/env.js': `const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGO_URI,
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  cors: process.env.CORS_ORIGIN || '*',
  uploadDir: process.env.UPLOAD_DIR || './uploads'
};`,

  'src/config/db.js': `const mongoose = require('mongoose');
const config = require('./env');

module.exports = async () => {
  try {
    await mongoose.connect(config.mongoUri, {
      dbName: 'startup_db'
    });
    console.log('✅ MongoDB Connected');
  } catch (e) {
    console.error('❌ DB Error:', e);
    process.exit(1);
  }
};`,

  'src/config/swagger.js': `const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Startup API',
      version: '1.0.0',
      description: 'Reusable Backend API'
    },
    servers: [{ url: 'http://localhost:3000' }]
  },
  apis: ['./src/routes/*.js']
};
const specs = swaggerJsdoc(options);

module.exports = { swaggerUi, specs };`,

  'src/utils/appError.js': `class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;`,

  'src/utils/catchAsync.js': `module.exports = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};`,

  'src/utils/apiFeatures.js': `class ApiFeatures {
  constructor(mongooseQuery, queryString) {
    this.mongooseQuery = mongooseQuery;
    this.queryString = queryString;
  }

  filter() {
    const queryObj = { ...this.queryString };
    const excluded = ['page', 'sort', 'limit', 'fields', 'keyword'];
    excluded.forEach(el => delete queryObj[el]);
    
    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\\b(gte|gt|lte|lt)\\b/g, match => '$' + match);
    this.mongooseQuery = this.mongooseQuery.find(JSON.parse(queryStr));
    return this;
  }

  sort() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(',').join(' ');
      this.mongooseQuery = this.mongooseQuery.sort(sortBy);
    } else {
      this.mongooseQuery = this.mongooseQuery.sort('-createdAt');
    }
    return this;
  }

  limitFields() {
    if (this.queryString.fields) {
      const fields = this.queryString.fields.split(',').join(' ');
      this.mongooseQuery = this.mongooseQuery.select(fields);    } else {
      this.mongooseQuery = this.mongooseQuery.select('-__v');
    }
    return this;
  }

  search(keywordFields) {
    if (this.queryString.keyword) {
      const regex = new RegExp(this.queryString.keyword, 'i');
      this.mongooseQuery = this.mongooseQuery.find({
        $or: keywordFields.map(field => ({ [field]: regex }))
      });
    }
    return this;
  }

  paginate() {
    const page = this.queryString.page * 1 || 1;
    const limit = this.queryString.limit * 1 || 10;
    const skip = (page - 1) * limit;
    this.mongooseQuery = this.mongooseQuery.skip(skip).limit(limit);
    this.paginate = { page, limit, skip };
    return this;
  }
}

module.exports = ApiFeatures;`,

  'src/models/User.js': `const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  role: {
    type: String,    enum: ['user', 'admin'],
    default: 'user'
  }
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);`,

  'src/models/Product.js': `const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true
  },
  image: String,
  description: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);`,

  'src/services/authService.js': `const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/appError');
const config = require('../config/env');

const signToken = id => jwt.sign({ id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

exports.register = async (data) => {
  const exists = await User.findOne({ email: data.email });
  if (exists) throw new AppError('Email already exists', 409);
  const user = await User.create(data);  const token = signToken(user._id);
  return { user: { id: user._id, name: user.name, email: user.email, role: user.role }, token };
};

exports.login = async ({ email, password }) => {
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  const token = signToken(user._id);
  return { user: { id: user._id, name: user.name, email: user.email, role: user.role }, token };
};`,

  'src/services/genericService.js': `const ApiFeatures = require('../utils/apiFeatures');

module.exports = {
  create: (Model) => async (data) => Model.create(data),
  getOne: (Model) => async (id, populateOptions) => Model.findById(id).populate(populateOptions),
  getAll: (Model) => async (query, populateOptions) => {
    const features = new ApiFeatures(Model.find(), query)
      .filter()
      .sort()
      .limitFields()
      .search(['name', 'description'])
      .paginate();
    const docs = await features.mongooseQuery.populate(populateOptions);
    return { docs, meta: { page: features.paginate.page, limit: features.paginate.limit } };
  },
  update: (Model) => async (id, data) => Model.findByIdAndUpdate(id, data, { new: true, runValidators: true }),
  delete: (Model) => async (id) => Model.findByIdAndDelete(id)
};`,

  'src/controllers/authController.js': `const { register, login } = require('../services/authService');
const catchAsync = require('../utils/catchAsync');

exports.signup = catchAsync(async (req, res) => {
  const result = await register(req.body);
  res.status(201).json({ status: 'success', data: result });
});

exports.login = catchAsync(async (req, res) => {
  const result = await login(req.body);
  res.status(200).json({ status: 'success',  result });
});`,

  'src/controllers/genericController.js': `const genericService = require('../services/genericService');

module.exports = (Model) => ({
  create: async (req, res) => {
    const doc = await genericService.create(Model)(req.body);    res.status(201).json({ status: 'success',  doc });
  },
  getAll: async (req, res) => {
    const { docs, meta } = await genericService.getAll(Model)(req.query, req.populateOptions);
    res.status(200).json({ status: 'success', results: docs.length, meta, data: docs });
  },
  getOne: async (req, res) => {
    const doc = await genericService.getOne(Model)(req.params.id, req.populateOptions);
    res.status(200).json({ status: 'success', data: doc });
  },
  update: async (req, res) => {
    const doc = await genericService.update(Model)(req.params.id, req.body);
    res.status(200).json({ status: 'success',  doc });
  },
  delete: async (req, res) => {
    await genericService.delete(Model)(req.params.id);
    res.status(204).json({ status: 'success' });
  }
});`,

  'src/middleware/auth.js': `const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/appError');
const config = require('../config/env');

exports.protect = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null;
  if (!token) return next(new AppError('Please login first', 401));

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(decoded.id);
    if (!user) return next(new AppError('User not found', 401));
    req.user = user;
    next();
  } catch {
    next(new AppError('Invalid token', 401));
  }
};

exports.restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new AppError('You do not have permission', 403));
  }
  next();
};`,

  'src/middleware/validator.js': `const { ZodError } = require('zod');

module.exports = (schema) => (req, res, next) => {  try {
    schema.parse(req.body);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const errors = err.errors.map(e => \`\${e.path.join('.')}: \${e.message}\`);
      return res.status(400).json({ status: 'fail', errors });
    }
    next(err);
  }
};`,

  'src/middleware/upload.js': `const multer = require('multer');
const path = require('path');
const config = require('../config/env');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, \`\${uniqueSuffix}\${path.extname(file.originalname)}\`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|pdf|docx/;
  const isValid = allowed.test(path.extname(file.originalname).toLowerCase()) && /image|application/.test(file.mimetype);
  cb(null, isValid);
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });`,

  'src/middleware/errorHandler.js': `const AppError = require('../utils/appError');

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
};`,

  'src/middleware/logger.js': `const winston = require('winston');

module.exports = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});`,

  'src/routes/auth.routes.js': `const express = require('express');
const { signup, login } = require('../controllers/authController');
const router = express.Router();

router.post('/signup', signup);
router.post('/login', login);

module.exports = router;`,

  'src/routes/index.routes.js': `const express = require('express');
const router = express.Router();
const authRoutes = require('./auth.routes');
const createResource = require('../controllers/genericController');
const Product = require('../models/Product');
const upload = require('../middleware/upload');
const { protect, restrictTo } = require('../middleware/auth');
const { validate } = require('../middleware/validator');
const { z } = require('zod');

const productCtrl = createResource(Product);

router.use((req, res, next) => {
  if (req.path.startsWith('/products')) req.populateOptions = 'createdBy';
  next();
});

router.use('/auth', authRoutes);

router.get('/products', productCtrl.getAll);
router.get('/products/:id', productCtrl.getOne);
router.post('/products', protect, upload.single('image'), validate(z.object({
  name: z.string().min(3),
  price: z.number().positive(),
  description: z.string().optional()
})), (req, res, next) => {
  req.body.image = req.file ? req.file.path : undefined;
  req.body.createdBy = req.user.id;
  next();
}, productCtrl.create);
router.put('/products/:id', protect, productCtrl.update);
router.delete('/products/:id', protect, restrictTo('admin'), productCtrl.delete);

module.exports = router;`,
  'src/app.js': `const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const routes = require('./routes');
const { swaggerUi, specs } = require('./config/swagger');
const config = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const AppError = require('./utils/appError');

const app = express();

app.use(helmet());
app.use(cors({ origin: config.cors, credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.json({ limit: '10kb' }));
app.use(morgan('dev'));

app.use('/uploads', express.static(config.uploadDir));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
app.use('/api', routes);

app.all('*', (req, res, next) => next(new AppError(\`Route \${req.originalUrl} not found\`, 404)));
app.use(errorHandler);

module.exports = app;`,

  'server.js': `require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/db');
const config = require('./src/config/env');

const start = async () => {
  await connectDB();
  app.listen(config.port, () => {
    console.log(\`🚀 Server running on http://localhost:\${config.port} [\${config.env}]\`);
  });
};

start();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));`,

  '.env.example': `NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/startup_db
JWT_SECRET=your_super_secret_key_change_in_prodCORS_ORIGIN=http://localhost:5173
UPLOAD_DIR=./uploads`,

  'package.json': `{
  "name": "startup-backend",
  "version": "1.0.0",
  "description": "Reusable, modular & production-ready Express backend",
  "main": "server.js",
  "scripts": {
    "dev": "nodemon server.js",
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "mongoose": "^8.0.0",
    "dotenv": "^16.3.1",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "zod": "^3.22.4",
    "helmet": "^7.1.0",
    "cors": "^2.8.5",
    "express-rate-limit": "^7.1.4",
    "multer": "^1.4.5-lts.1",
    "winston": "^3.11.0",
    "swagger-jsdoc": "^6.2.8",
    "swagger-ui-express": "^5.0.0",
    "morgan": "^1.10.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}`
};

Object.entries(structure).forEach(([file, content]) => {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, content);
  console.log('✅ Created:', file);
});

console.log('\n🎉 Project scaffolded! Run:');
console.log('npm install');
console.log('cp .env.example .env');
console.log('npm run dev');
