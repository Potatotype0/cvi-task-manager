// Sends one notification to every device of the person it belongs to.
// Callers only pass a notification id, and pushed_at makes each one send once,
// so this function needs no login and reveals nothing if called from outside.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type Language = 'ar' | 'en'

const messages: Record<Language, Record<string, string>> = {
  ar: {
    appName: 'مدير مهام CVI',
    assigned: 'كُلّفت بمهمة جديدة',
    review: 'مهمة بانتظار مراجعتك',
    approved: 'تم اعتماد مهمتك',
    returned: 'أُعيدت مهمتك',
    comment: 'تعليق جديد',
    completed: 'تم إنهاء مهمة',
    overdue_manager: 'مهمة متأخرة في قسمك',
    morning: 'اليوم: {0}، قريبًا: {1}، متأخرة: {2}',
    weekly: 'هذا الأسبوع: {0} مكتملة، {1} متأخرة، {2} للمراجعة',
    backup: 'حان وقت تنزيل النسخة الاحتياطية الشهرية من صفحة التقارير',
  },
  en: {
    appName: 'CVI Task Manager',
    assigned: 'You were assigned a new task',
    review: 'A task is waiting for your review',
    approved: 'Your task was approved',
    returned: 'Your task was returned',
    comment: 'New comment',
    completed: 'A task was finished',
    overdue_manager: 'A task in your department is late',
    morning: 'Today: {0}, coming up: {1}, late: {2}',
    weekly: 'This week: {0} finished, {1} late, {2} to review',
    backup: 'Time to download the monthly backup from the Reports page',
  },
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

webpush.setVapidDetails(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

function textFor(language: Language, kind: string, detail: string | null) {
  const parts = (detail || '').split('|')
  const template = messages[language][kind] || messages[language].appName
  return template.replace(/\{(\d)\}/g, (_, i) => parts[Number(i)] ?? '0')
}

Deno.serve(async (req) => {
  const { notification_id } = await req.json().catch(() => ({}))
  if (!notification_id) return new Response('missing id', { status: 400 })

  const { data: note } = await db.from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', notification_id).is('pushed_at', null)
    .select('user_id, task_id, kind, detail').maybeSingle()
  if (!note) return new Response('nothing to send')

  const { data: devices } = await db.from('push_subscriptions').select('*').eq('user_id', note.user_id)
  if (!devices?.length) return new Response('no devices')

  const { data: task } = note.task_id
    ? await db.from('tasks').select('title').eq('id', note.task_id).maybeSingle()
    : { data: null }

  await Promise.all(devices.map(async (device) => {
    const language: Language = device.language === 'en' ? 'en' : 'ar'
    const text = textFor(language, note.kind, note.detail)
    const payload = JSON.stringify({
      title: task ? text : messages[language].appName,
      body: task ? task.title : text,
      taskId: note.task_id,
    })
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        { TTL: 86400 },
      )
    } catch (error) {
      // The device turned notifications off or removed the app.
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await db.from('push_subscriptions').delete().eq('endpoint', device.endpoint)
      } else {
        console.error('push failed', status, (error as Error).message)
      }
    }
  }))
  return new Response('sent')
})
