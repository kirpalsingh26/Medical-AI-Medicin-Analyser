import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data.data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (localStorage.getItem('medvision_token')) {
      loadMe();
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('medvision_token', data.data.token);
    setUser({
      id: data.data.id,
      name: data.data.name,
      email: data.data.email,
      preferredLanguage: data.data.preferredLanguage
    });
  };

  const register = async (name, email, password) => {
    const { data } = await api.post('/auth/register', { name, email, password });
    localStorage.setItem('medvision_token', data.data.token);
    setUser({
      id: data.data.id,
      name: data.data.name,
      email: data.data.email,
      preferredLanguage: data.data.preferredLanguage
    });
  };

  const logout = () => {
    localStorage.removeItem('medvision_token');
    setUser(null);
  };

  const value = useMemo(() => ({ user, loading, login, logout, register }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);