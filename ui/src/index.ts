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

app.get('/logout', (req, res) => {
  res.render('logout', { title: 'Zero Data Fabric - Logout' });
});

app.get('/dashboard', (req, res) => {
  res.render('dashboard', { title: 'Zero Data Fabric - Dashboard' });
});

app.get('/tenants', (req, res) => {
  res.render('tenants', { title: 'Zero Data Fabric - Tenants' });
});

app.get('/connections', (req, res) => {
  res.render('connections', { title: 'Zero Data Fabric - Connections' });
});

app.get('/workbench', (req, res) => {
  res.render('workbench', { title: 'Zero Data Fabric - Workbench' });
});

app.get('/workbench/docs', (req, res) => {
  res.render('workbench_docs', { title: 'Zero Data Fabric - Workbench Docs' });
});

app.get('/iam', (req, res) => {
  res.render('iam', { title: 'Zero Data Fabric - IAM' });
});

app.get('/audit', (req, res) => {
  res.render('audit', { title: 'Zero Data Fabric - Audit Logs' });
});

app.get('/triggers', (req, res) => {
  res.render('triggers', { title: 'Zero Data Fabric - Trigger Control Plane' });
});

app.get('/catalog', (req, res) => {
  res.render('catalog', { title: 'Zero Data Fabric - Discovery Catalog' });
});

app.get('/metadata', (req, res) => {
  res.render('metadata', { title: 'Zero Data Fabric - Metadata Orchestration' });
});

app.get('/analytics', (req, res) => {
  res.render('analytics', { title: 'Zero Data Fabric - Analytics Dashboard' });
});

app.get('/settings', (req, res) => {
  res.render('settings', { title: 'Zero Data Fabric - Settings' });
});

app.listen(PORT, () => {
  console.log(`Data Fabric Management UI (EJS) listening on port ${PORT}`);
});
