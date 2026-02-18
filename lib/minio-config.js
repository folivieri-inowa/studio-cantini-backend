import * as Minio from 'minio';

/**
 * Configuration for MinIO client
 * Uses environment variables with fallback to local Docker MinIO
 */
export const getMinioConfig = () => {
  const useLocalStorage = process.env.USE_LOCAL_STORAGE === 'true';

  if (useLocalStorage) {
    return null; // Signal to use local filesystem instead
  }

  // Check if we have production MinIO configured
  const hasProductionConfig = process.env.MINIO_ENDPOINT &&
    process.env.MINIO_ENDPOINT.includes('studiocantini.wavetech.it');

  // If production config is present and we're not forcing local, use it
  if (hasProductionConfig && process.env.NODE_ENV === 'production') {
    return {
      endPoint: process.env.MINIO_ENDPOINT,
      port: parseInt(process.env.MINIO_PORT || '443', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
    };
  }

  // Default to local Docker MinIO
  return {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9002', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
  };
};

/**
 * Get the base URL for MinIO objects
 */
export const getMinioBaseUrl = () => {
  const config = getMinioConfig();

  if (!config) {
    return null;
  }

  const protocol = config.useSSL ? 'https' : 'http';

  // For local development, use localhost
  if (config.endPoint === 'localhost' || config.endPoint === '127.0.0.1') {
    return `${protocol}://localhost:${config.port}`;
  }

  return `${protocol}://${config.endPoint}${config.port === 443 ? '' : ':' + config.port}`;
};

/**
 * Create a MinIO client instance
 */
export const createMinioClient = () => {
  const config = getMinioConfig();

  if (!config) {
    throw new Error('Local storage is enabled, MinIO client not available');
  }

  return new Minio.Client(config);
};

/**
 * Ensure a bucket exists, create it if it doesn't
 */
export const ensureBucketExists = async (minioClient, bucketName) => {
  const bucketExists = await minioClient.bucketExists(bucketName);
  if (!bucketExists) {
    await minioClient.makeBucket(bucketName, 'us-east-1');
  }
};
