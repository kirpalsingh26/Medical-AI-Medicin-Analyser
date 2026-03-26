import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Loader from './Loader';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();

  if (loading) return <Loader text="Checking authentication..." />;
  if (!user) return <Navigate to="/auth" replace />;
  return children;
};

export default ProtectedRoute;