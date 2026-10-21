import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { get } from './api';
import { ToastProvider, useAsync, Loading } from './ui';
import Setup from './pages/Setup';
import Login from './pages/Login';
import PublicProfile from './pages/PublicProfile';
import Connect from './pages/Connect';
import AdminLayout from './pages/admin/Layout';
import Home from './pages/admin/Home';
import MyData from './pages/admin/MyData';
import LifeHub from './pages/admin/LifeHub';
import Category from './pages/admin/Category';
import Timeline from './pages/admin/Timeline';
import Contacts from './pages/admin/Contacts';
import ContactDetail from './pages/admin/ContactDetail';
import PublicEditor from './pages/admin/PublicEditor';
import Apps from './pages/admin/Apps';
import Settings from './pages/admin/Settings';
import { DataModel, Endpoints } from './pages/admin/Reference';

/** "/" is the setup page until someone claims this Little Dipper, then the public profile. */
function Root() {
  const { data } = useAsync(() => get<{ claimed: boolean }>('/api/v1/node/status'), []);
  if (!data) return <div style={{ padding: 48 }}><Loading /></div>;
  return data.claimed ? <PublicProfile /> : <Setup />;
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Root />} />
          <Route path="/claim" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Home />} />
            <Route path="data" element={<Navigate to="/admin/life/profile" replace />} />
            <Route path="life" element={<LifeHub />} />
            <Route path="life/profile" element={<MyData />} />
            <Route path="life/timeline" element={<Timeline />} />
            <Route path="life/:domain" element={<Category />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="contacts/:id" element={<ContactDetail />} />
            <Route path="public" element={<PublicEditor />} />
            <Route path="apps" element={<Apps />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/:tab" element={<Settings />} />
            <Route path="reference/model" element={<DataModel />} />
            <Route path="reference/endpoints" element={<Endpoints />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
