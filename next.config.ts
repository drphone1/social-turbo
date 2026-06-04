import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    '*': [
      'ALL-BACKUPS/**',
      'Backup_Phase1_Extracted/**',
      'Backup_Step0_Extracted/**',
      'backup_phase1/**',
      'sessions/**',
      'logs/**',
      'work station/**',
      'uploads/**',
    ],
  },
  devIndicators: {
    appIsrStatus: false,
    buildActivity: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    const ignored = [
      '**/node_modules/**',
      '**/.next/**',
      '**/ALL-BACKUPS/**',
      '**/Backup_Phase1_Extracted/**',
      '**/Backup_Step0_Extracted/**',
      '**/backup_phase1/**',
      '**/sessions/**',
      '**/logs/**',
      '**/work station/**',
      '**/uploads/**',
    ];

    config.watchOptions = {
      ...config.watchOptions,
      ignored,
    };

    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
