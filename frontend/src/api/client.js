import axios from 'axios';

const defaultApiUrls = [
  'http://localhost:5001/api',
  'http://localhost:5002/api',
  'http://localhost:5003/api',
  'http://localhost:5004/api',
  'http://localhost:5005/api'
];

const preferredApiUrl = import.meta.env.VITE_API_URL || defaultApiUrls[0];
const apiUrls = Array.from(new Set([preferredApiUrl, ...defaultApiUrls]));

const api = axios.create({
  baseURL: preferredApiUrl
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('medvision_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    if (!config) throw error;

    const noHttpResponse = !error.response;
    if (!noHttpResponse) throw error;

    const alreadyRetried = config.__apiFailoverRetried === true;
    if (alreadyRetried) throw error;

    const currentBase = config.baseURL || api.defaults.baseURL;
    const currentIndex = apiUrls.indexOf(currentBase);
    const nextBase = apiUrls[currentIndex + 1];

    if (!nextBase) throw error;

    config.__apiFailoverRetried = true;
    config.baseURL = nextBase;
    api.defaults.baseURL = nextBase;

    return api.request(config);
  }
);

export default api;