import withPWA from 'next-pwa'
import createNextIntlPlugin from 'next-intl/plugin'
import { setupDevPlatform } from '@cloudflare/next-on-pages/next-dev';

async function setup() {
  if (process.env.NODE_ENV === 'development') {
    await setupDevPlatform()
  }
}

setup()

const withNextIntl = createNextIntlPlugin('./app/i18n/request.ts')

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    AUTH_SECRET: '6b8e3a2410f97bc45df891c2803bda9e172a50c8e3146059d7b4c919d8548a62',
    AUTH_GITHUB_ID: 'Ov23li8VQpR7E7Zf0AdQ',
    AUTH_GITHUB_SECRET: '776bcf86d1b447cd75bb13ea2395bb1cce96096a',
    AUTH_TRUST_HOST: 'true',
    CUSTOM_DOMAIN: 'auau.cc.cd',
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: '*.googleusercontent.com',
      }
    ],
  },
};

const withPWAConfigured = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
}) as any

const configWithPWA = withPWAConfigured(nextConfig as any) as any

export default withNextIntl(configWithPWA)