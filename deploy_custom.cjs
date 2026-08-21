const Cloudflare = require('cloudflare');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const PROJECT_NAME = process.env.PROJECT_NAME || 'moemail';
const DATABASE_NAME = process.env.DATABASE_NAME || 'moemail-db';
const KV_NAMESPACE_NAME = process.env.KV_NAMESPACE_NAME || 'moemail-kv';
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;

const client = new Cloudflare({
  apiToken: CF_API_TOKEN,
});

async function main() {
  console.log('🚀 Step 1: Initializing Cloudflare D1 Database...');
  let databaseId = null;
  const d1List = await client.d1.database.list({ account_id: CF_ACCOUNT_ID });
  const existingDb = (d1List.result || []).find(db => db.name === DATABASE_NAME);
  if (existingDb) {
    databaseId = existingDb.uuid;
    console.log(`✅ D1 Database "${DATABASE_NAME}" already exists (ID: ${databaseId})`);
  } else {
    console.log(`🆕 Creating D1 Database "${DATABASE_NAME}"...`);
    const createdDb = await client.d1.database.create({
      account_id: CF_ACCOUNT_ID,
      name: DATABASE_NAME,
    });
    databaseId = createdDb.uuid;
    console.log(`✅ D1 Database created (ID: ${databaseId})`);
  }

  console.log('\n🚀 Step 2: Initializing Cloudflare KV Namespace...');
  let kvId = null;
  const kvList = await client.kv.namespaces.list({ account_id: CF_ACCOUNT_ID });
  const existingKv = (kvList.result || []).find(ns => ns.title === KV_NAMESPACE_NAME);
  if (existingKv) {
    kvId = existingKv.id;
    console.log(`✅ KV Namespace "${KV_NAMESPACE_NAME}" already exists (ID: ${kvId})`);
  } else {
    console.log(`🆕 Creating KV Namespace "${KV_NAMESPACE_NAME}"...`);
    const createdKv = await client.kv.namespaces.create({
      account_id: CF_ACCOUNT_ID,
      title: KV_NAMESPACE_NAME,
    });
    kvId = createdKv.id;
    console.log(`✅ KV Namespace created (ID: ${kvId})`);
  }

  console.log('\n🚀 Step 3: Generating configuration files (wrangler.json, wrangler.email.json, wrangler.cleanup.json)...');
  
  // wrangler.json
  const wranglerExample = JSON.parse(fs.readFileSync(path.resolve('wrangler.example.json'), 'utf-8'));
  wranglerExample.name = PROJECT_NAME;
  if (wranglerExample.d1_databases?.[0]) {
    wranglerExample.d1_databases[0].database_name = DATABASE_NAME;
    wranglerExample.d1_databases[0].database_id = databaseId;
  }
  if (wranglerExample.kv_namespaces?.[0]) {
    wranglerExample.kv_namespaces[0].id = kvId;
  }
  fs.writeFileSync(path.resolve('wrangler.json'), JSON.stringify(wranglerExample, null, 2));

  // wrangler.email.json
  const emailExample = JSON.parse(fs.readFileSync(path.resolve('wrangler.email.example.json'), 'utf-8'));
  emailExample.name = `${PROJECT_NAME}-email-receiver-worker`;
  if (emailExample.d1_databases?.[0]) {
    emailExample.d1_databases[0].database_name = DATABASE_NAME;
    emailExample.d1_databases[0].database_id = databaseId;
  }
  fs.writeFileSync(path.resolve('wrangler.email.json'), JSON.stringify(emailExample, null, 2));

  // wrangler.cleanup.json
  const cleanupExample = JSON.parse(fs.readFileSync(path.resolve('wrangler.cleanup.example.json'), 'utf-8'));
  cleanupExample.name = `${PROJECT_NAME}-cleanup-worker`;
  if (cleanupExample.d1_databases?.[0]) {
    cleanupExample.d1_databases[0].database_name = DATABASE_NAME;
    cleanupExample.d1_databases[0].database_id = databaseId;
  }
  fs.writeFileSync(path.resolve('wrangler.cleanup.json'), JSON.stringify(cleanupExample, null, 2));
  console.log('✅ Configuration files generated.');

  console.log('\n🚀 Step 4: Applying D1 remote database migrations...');
  try {
    execSync(`npx wrangler d1 migrations apply ${DATABASE_NAME} --remote -y`, { stdio: 'inherit' });
    console.log('✅ D1 migrations applied successfully.');
  } catch (e) {
    console.error('⚠️ D1 migration warning/error:', e.message);
  }

  console.log('\n🚀 Step 5: Initializing Cloudflare Pages project and domain...');
  try {
    const pagesList = await client.pages.projects.list({ account_id: CF_ACCOUNT_ID });
    const existingProject = (pagesList.result || []).find(p => p.name === PROJECT_NAME);
    if (!existingProject) {
      console.log(`🆕 Creating Pages project "${PROJECT_NAME}"...`);
      await client.pages.projects.create({
        account_id: CF_ACCOUNT_ID,
        name: PROJECT_NAME,
        production_branch: 'main',
      });
      console.log(`✅ Pages project "${PROJECT_NAME}" created.`);
    } else {
      console.log(`✅ Pages project "${PROJECT_NAME}" already exists.`);
    }
  } catch (err) {
    console.log('Pages project create note:', err.message);
  }

  if (CUSTOM_DOMAIN) {
    try {
      console.log(`🔗 Setting custom domain "${CUSTOM_DOMAIN}" for Pages project "${PROJECT_NAME}"...`);
      await client.pages.projects.domains.create(PROJECT_NAME, {
        account_id: CF_ACCOUNT_ID,
        name: CUSTOM_DOMAIN,
      });
      console.log(`✅ Custom domain "${CUSTOM_DOMAIN}" attached to Pages project.`);
    } catch (domainErr) {
      console.log('Domain setting note (might already exist):', domainErr.message);
    }
  }

  console.log('\n🚀 Step 6: Setting Cloudflare Pages Secrets...');
  const secrets = {
    AUTH_GITHUB_ID: process.env.AUTH_GITHUB_ID || '',
    AUTH_GITHUB_SECRET: process.env.AUTH_GITHUB_SECRET || '',
    AUTH_SECRET: process.env.AUTH_SECRET || '',
    NEXTAUTH_URL: CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : `https://${PROJECT_NAME}.pages.dev`,
  };
  const secretJsonPath = path.resolve('.env.runtime.json');
  fs.writeFileSync(secretJsonPath, JSON.stringify(secrets, null, 2));
  try {
    execSync(`npx wrangler pages secret bulk ${secretJsonPath} --project-name ${PROJECT_NAME}`, { stdio: 'inherit' });
    console.log('✅ Pages secrets configured successfully.');
  } catch (err) {
    console.error('⚠️ Secrets upload error:', err.message);
  } finally {
    if (fs.existsSync(secretJsonPath)) fs.unlinkSync(secretJsonPath);
  }

  console.log('\n🚀 Step 7: Building Next.js application for Cloudflare Pages...');
  execSync('npm run build:pages', { stdio: 'inherit' });
  console.log('✅ Next-on-pages build complete.');

  console.log('\n🚀 Step 8: Deploying frontend to Cloudflare Pages...');
  execSync(`npx wrangler pages deploy .vercel/output/static --project-name ${PROJECT_NAME} --branch main`, { stdio: 'inherit' });
  console.log('✅ Cloudflare Pages deployed successfully.');

  console.log('\n🚀 Step 9: Deploying Email Receiver Worker...');
  execSync('npx wrangler deploy --config wrangler.email.json', { stdio: 'inherit' });
  console.log('✅ Email Receiver Worker deployed.');

  console.log('\n🚀 Step 10: Deploying Cleanup Worker (Cron trigger)...');
  execSync('npx wrangler deploy --config wrangler.cleanup.json', { stdio: 'inherit' });
  console.log('✅ Cleanup Worker deployed.');

  console.log('\n🎉 ALL DEPLOYMENT STEPS COMPLETED SUCCESSFULLY!');
}

main().catch(err => {
  console.error('💥 Fatal deployment error:', err);
  process.exit(1);
});