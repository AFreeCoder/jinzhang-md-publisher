export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  const configured = ['JINZHANG_ORIGIN', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'TRANSIT_TICKET_SECRET'].every((key) => Boolean(process.env[key]));
  return Response.json({ status: configured ? 'ready' : 'degraded', revision: process.env.APP_REVISION || 'development', transitConfigured: configured }, { status: configured ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
