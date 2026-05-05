import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.UI_PORT || 3001;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// UI Routes
app.get('/', (req, res) => {
  res.render('index', { title: 'Zero Data Fabric - Home' });
});

app.get('/login', (req, res) => {
  res.render('login', { title: 'Zero Data Fabric - Login' });
});

app.get('/dashboard', (req, res) => {
  // In a real app, check session/cookie here
  res.render('dashboard', { title: 'Zero Data Fabric - Dashboard' });
});

app.listen(PORT, () => {
  console.log(`Data Fabric Management UI (EJS) listening on port ${PORT}`);
});
