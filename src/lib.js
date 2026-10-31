import { createContext, useContext } from 'react'
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_KEY

export const supabase = createClient(url, key)

// Second client so the admin can create an account without being logged out.
export const signupClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: 'cvi-signup' },
})

export const emailOf = (username) => `${username.trim().toLowerCase().split('@')[0]}@cvi-tasks.local`
// Local calendar dates, so the day doesn't change at 3am Baghdad time.
export const dateAfter = (days) => new Date(Date.now() + days * 864e5).toLocaleDateString('en-CA')
export const today = () => dateAfter(0)
export const isLate = (task) => task.due_date && task.due_date < today() && task.status !== 'done'

export const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => values[k])
export const daysFromToday = (date) => Math.round((new Date(date) - new Date(today())) / 864e5)
export const formatDate = (date, lang) =>
  new Date(date).toLocaleDateString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' })

export function dueLabel(task, t, lang) {
  if (!task.due_date) return ''
  const n = daysFromToday(task.due_date)
  if (task.status !== 'done') {
    if (n === -1) return t('dayLate')
    if (n < 0) return fill(t('daysLate'), { n: -n })
    if (n === 0) return t('today')
    if (n === 1) return t('tomorrow')
  }
  return formatDate(task.due_date, lang)
}

export const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

export const TASK_SELECT = '*, task_assignees(user_id), checklist_items(done, required, needs_proof, proof_path)'
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const FREE_STORAGE_BYTES = 1024 * 1024 * 1024

export const canManage = (task, me) =>
  me.role === 'admin' || task.created_by === me.id || (me.role === 'manager' && task.department_id === me.department_id)
export const isAssigned = (task, me) => task.task_assignees.some((a) => a.user_id === me.id)
export const canWork = (task, me) => isAssigned(task, me) || canManage(task, me)
export const isReady = (items) =>
  (items || []).every((i) => !i.required || (i.done && (!i.needs_proof || i.proof_path)))

// The single next step for a task, used by list buttons and the task panel.
export function nextAction(task, me) {
  if (!canWork(task, me)) return null
  if (task.status === 'todo' || task.status === 'returned') return { status: 'in_progress', label: 'start' }
  if (task.status === 'in_progress') {
    return task.needs_approval ? { status: 'review', label: 'sendReview' } : { status: 'done', label: 'markDone' }
  }
  if (task.status === 'review' && canManage(task, me)) return { status: 'done', label: 'approve' }
  return null
}

// Inserts one task (or one per person when separate) with its people, checklist and files.
export async function createTasks({ fields, assignees, separate = true, checklist = [], files = [] }) {
  const groups = separate ? assignees.map((a) => [a]) : [assignees]
  for (const group of groups) {
    const { data: task, error } = await supabase.from('tasks').insert({ ...fields, is_shared: group.length > 1 }).select().single()
    if (error) throw error
    const a = await supabase.from('task_assignees').insert(group.map((user_id) => ({ task_id: task.id, user_id })))
    if (a.error) throw a.error
    if (checklist.length) {
      const c = await supabase.from('checklist_items').insert(checklist.map((i, position) => ({ ...i, position, task_id: task.id })))
      if (c.error) throw c.error
    }
    if (files.length) {
      const f = await supabase.from('attachments').insert(files.map((u) => ({ ...u, task_id: task.id })))
      if (f.error) throw f.error
    }
  }
}

// Photos are shrunk before upload so the free storage lasts. Anything unreadable goes up as it is.
async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75))
    return blob && blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file
  }
}

// Upload names can be Arabic, which storage paths refuse, so paths use a random id.
export async function uploadFile(folder, original) {
  const file = await shrinkImage(original)
  if (file.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_BIG')
  const ext = (file.name.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '')
  const path = `${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('task-files').upload(path, file)
  if (error) throw error
  return path
}

export async function openFile(path) {
  const { data, error } = await supabase.storage.from('task-files').createSignedUrl(path, 300)
  if (error) throw error
  window.open(data.signedUrl, '_blank', 'noopener')
}

export const dict = {
  ar: {
    appName: 'مدير مهام CVI', username: 'اسم المستخدم', password: 'كلمة المرور', login: 'تسجيل الدخول',
    loginFailed: 'اسم المستخدم أو كلمة المرور غير صحيحة', logout: 'خروج', disabled: 'تم إيقاف هذا الحساب',
    changePassword: 'تغيير كلمة المرور', newPassword: 'كلمة المرور الجديدة', save: 'حفظ', cancel: 'إلغاء', saved: 'تم الحفظ',
    myTasks: 'مهامي', board: 'لوحة المهام', dashboard: 'المتابعة', presets: 'القوالب', projects: 'المشاريع', people: 'الأشخاص',
    newTask: 'مهمة جديدة', search: 'بحث…', all: 'الكل', noTasks: 'لا توجد مهام هنا', showDone: 'إظهار المكتملة',
    title: 'العنوان', description: 'الوصف', priority: 'الأولوية', dueDate: 'تاريخ الاستحقاق', department: 'القسم', project: 'المشروع',
    drawingLink: 'رابط المخطط', none: 'بدون', assignees: 'المكلفون', status: 'الحالة', files: 'الملفات', addFiles: 'إرفاق ملفات',
    separate: 'نسخة منفصلة لكل شخص', shared: 'مهمة واحدة مشتركة', create: 'إنشاء',
    checklist: 'قائمة التحقق', addItem: 'إضافة بند', itemText: 'نص البند', required: 'إلزامي', needsProof: 'يتطلب إثبات', uploadProof: 'رفع الإثبات', viewProof: 'عرض الإثبات',
    todo: 'للتنفيذ', in_progress: 'قيد التنفيذ', review: 'للمراجعة', returned: 'مُعادة', done: 'مكتملة',
    low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة',
    start: 'بدء العمل', sendReview: 'إرسال للمراجعة', approve: 'اعتماد', returnTask: 'إعادة مع تعليق', returnReason: 'سبب الإعادة', deleteTask: 'حذف المهمة', confirmDelete: 'هل تريد الحذف؟',
    comments: 'التعليقات', addComment: 'اكتب تعليقًا…', send: 'إرسال', readOnly: 'عرض فقط: هذه المهمة ليست مكلفًا بها', late: 'متأخرة',
    finishChecklist: 'أكمل البنود الإلزامية (مع الإثبات) أولًا',
    notifications: 'الإشعارات', noNotifications: 'لا توجد إشعارات', markRead: 'تعليم الكل كمقروء',
    n_assigned: 'كُلّفت بمهمة', n_review: 'مهمة بانتظار مراجعتك', n_approved: 'تم اعتماد مهمتك', n_returned: 'أُعيدت مهمتك', n_comment: 'تعليق جديد',
    n_completed: 'تم إنهاء مهمة', n_due_soon: 'موعدها قريب', n_overdue: 'مهمة متأخرة', n_overdue_manager: 'مهمة متأخرة في قسمك', n_morning: 'اليوم: {0}، قريبًا: {1}، متأخرة: {2}', n_weekly: 'هذا الأسبوع: {0} مكتملة، {1} متأخرة، {2} للمراجعة',
    installTitle: 'تثبيت التطبيق', installNow: 'تثبيت الآن', installWhy: 'ثبّت التطبيق على هاتفك لتفتحه بضغطة واحدة وتصلك الإشعارات.', iosStep1: 'افتح هذا الرابط في Safari.', iosStep2: 'اضغط زر المشاركة أسفل الشاشة.', iosStep3: 'اختر «إضافة إلى الشاشة الرئيسية» ثم «إضافة».', iosStep4: 'افتح التطبيق من أيقونته الجديدة وسجّل الدخول.', iosVersion: 'الإشعارات تحتاج iOS 16.4 أو أحدث.', androidStep1: 'افتح هذا الرابط في Chrome.', androidStep2: 'اضغط النقاط الثلاث في الأعلى.', androidStep3: 'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».',
    notifyAsk: 'فعّل الإشعارات لتعرف بمهامك فور وصولها.', notifyInstallFirst: 'لتصلك الإشعارات على iPhone، ثبّت التطبيق أولًا.', notifyTurnOn: 'تفعيل الإشعارات', notifyTurnOff: 'إيقاف الإشعارات', notifyOn: 'تم تفعيل الإشعارات', notifyOff: 'تم إيقاف الإشعارات', notifyBlocked: 'الإشعارات محظورة. فعّلها من إعدادات المتصفح.',
    lateTasks: 'المهام المتأخرة', inReview: 'بانتظار المراجعة', openTasks: 'مهام مفتوحة', workload: 'توزيع العمل', person: 'الشخص', noLate: 'لا توجد مهام متأخرة',
    newPreset: 'قالب جديد', daysUntilDue: 'أيام حتى الاستحقاق', companyWide: 'كل الشركة', use: 'استخدام', edit: 'تعديل', remove: 'حذف', repeat: 'تكرار',
    repeatNone: 'مرة واحدة الآن', daily: 'يوميًا', weekly: 'أسبوعيًا', monthly: 'شهريًا', firstRun: 'أول تشغيل', repeating: 'التكرارات الفعالة', stop: 'إيقاف', noPresets: 'لا توجد قوالب بعد', created: 'تم الإنشاء',
    addProject: 'إضافة مشروع', projectName: 'اسم المشروع', code: 'الرمز', deadline: 'الموعد النهائي', archive: 'أرشفة', noProjects: 'لا توجد مشاريع بعد',
    addPerson: 'إضافة شخص', fullName: 'الاسم الكامل', role: 'الدور', admin: 'مدير النظام', manager: 'مدير', employee: 'موظف', active: 'نشط', resetPassword: 'إعادة تعيين كلمة المرور', deactivate: 'إيقاف', activate: 'تفعيل',
    usernameRule: 'أحرف إنجليزية وأرقام فقط', passwordRule: 'كلمة المرور 6 أحرف على الأقل', confirmOff: 'تم إنشاء الحساب لكنه يحتاج تأكيدًا: أوقف Confirm email في Supabase',
    departments: 'الأقسام', nameAr: 'الاسم بالعربية', nameEn: 'الاسم بالإنجليزية', addDepartment: 'إضافة قسم', error: 'حدث خطأ',
    overview: 'نظرة عامة', hello: 'مرحبًا', menu: 'الحساب', language: 'English', loginIntro: 'سجّل الدخول باسم المستخدم الذي أعطاك إياه مدير النظام.', loginTag: 'المهام والمراجعة والاعتماد في مكان واحد',
    today: 'اليوم', tomorrow: 'غدًا', dayLate: 'متأخرة يومًا واحدًا', daysLate: 'متأخرة {n} يوم', g_returned: 'أُعيدت إليك', g_late: 'متأخرة', g_today: 'اليوم', g_week: 'خلال 7 أيام', g_later: 'لاحقًا', g_nodate: 'بدون موعد', g_done: 'مكتملة',
    allClear: 'لا شيء عليك الآن', allClearHint: 'ستظهر مهامك الجديدة هنا فور تكليفك بها.', sumNone: 'لا توجد مهام مفتوحة عليك.', sumOpen: 'عليك {n} مهام مفتوحة', sumLate: '، منها {n} متأخرة', sumToday: '، و{n} موعدها اليوم',
    overviewClear: 'كل شيء تحت السيطرة: لا مراجعات ولا تأخير.', overviewSum: '{r} بانتظار مراجعتك و{l} متأخرة من أصل {o} مهمة مفتوحة.', needsReview: 'بانتظار مراجعتك', noReview: 'لا شيء بانتظار المراجعة',
    nextStep: 'الخطوة التالية', stepAssigned: 'بانتظار المكلف ليبدأ العمل.', waitingReview: 'أُرسلت للمراجعة. بانتظار قرار المدير.', stampDone: 'معتمدة', stampReturned: 'مُعادة', returnedBecause: 'سبب الإعادة', approvedOn: 'تم اعتماد هذه المهمة.',
    details: 'تفاصيل', more: 'خيارات إضافية', startFrom: 'البدء من قالب', blank: 'مهمة فارغة', whatTitle: 'ما المطلوب؟', whoTitle: 'من سينفذها؟', whenTitle: 'متى؟', inWeek: 'بعد أسبوع', noDate: 'بدون موعد', searchPeople: 'ابحث عن شخص…', pickAssignee: 'اختر شخصًا واحدًا على الأقل', separateHint: 'كل شخص يتابع مهمته وحده', sharedHint: 'الجميع يعملون على المهمة نفسها', optional: 'اختياري', createTask: 'إنشاء المهمة', createTasks: 'إنشاء {n} مهام',
    noPresetsHint: 'احفظ المهام المتكررة كقوالب لتنشئها بضغطة واحدة.', noProjectsHint: 'أضف مشروعًا لربط المهام به.', items: 'بنود', dueIn: 'الاستحقاق بعد {n} يوم', copy: 'نسخ', copied: 'تم النسخ', accountReady: 'الحساب جاهز. أرسل هذه البيانات إلى {name}:', done_btn: 'تم', inactive: 'موقوف', setPassword: 'تعيين كلمة مرور جديدة', savePreset: 'حفظ القالب', noResults: 'لا توجد نتائج', lateOnly: 'المتأخرة فقط',
    markDone: 'إنهاء', reopen: 'إعادة فتح', needsApproval: 'تحتاج اعتماد المدير', needsApprovalHint: 'عند إيقافها، يُنهي المكلف المهمة بنفسه', needsManager: 'هذه المهمة تحتاج اعتماد المدير', fileTooBig: 'حجم الملف أكبر من 10 ميغابايت. ضع رابطًا له بدلًا من رفعه.',
    quickAddPlaceholder: 'أضف مهمة بسرعة واضغط Enter…', quickForMe: 'لي', moreDetails: 'تفاصيل أكثر', forYourself: 'هذه المهمة لك أنت، ويراها مدير قسمك أيضًا.',
    searchAll: 'بحث', paletteHint: 'ابحث عن مهمة أو شخص أو مشروع…', goTo: 'الانتقال إلى', shortcuts: 'Ctrl+K للبحث، N لمهمة جديدة، والأرقام 1 إلى 7 للتنقل',
    columns: 'أعمدة', listView: 'قائمة', selected: 'محدد', reassign: 'تغيير المكلف', changeDate: 'تغيير الموعد', changePriority: 'تغيير الأولوية', clear: 'إلغاء التحديد', onlyManagerMove: 'لا يمكنك نقل هذه المهمة إلى هناك',
    trash: 'المحذوفات', trashHint: 'تُحذف المهام نهائيًا بعد 30 يومًا من وضعها هنا.', trashEmpty: 'المحذوفات فارغة', restore: 'استعادة', movedToTrash: 'نُقلت إلى المحذوفات', restored: 'تمت الاستعادة', deletedOn: 'حُذفت',
    history: 'سجل التغييرات', h_created: 'أنشأ المهمة', h_status: 'غيّر الحالة إلى', h_due: 'غيّر الموعد إلى', h_priority: 'غيّر الأولوية إلى', h_title: 'غيّر العنوان إلى', h_deleted: 'حذف المهمة', h_restored: 'استعاد المهمة', h_assigned: 'كلّف', h_unassigned: 'أزال التكليف عن',
    storage: 'مساحة الملفات', storageUsed: 'مستخدم {used} من {total}', storageWarn: 'مساحة الملفات توشك على الامتلاء. فكّر في الترقية إلى الخطة المدفوعة.', dbUpdate: 'قاعدة البيانات تحتاج تحديثًا: شغّل patch-02-stage-1.sql في Supabase.',
  },
  en: {
    appName: 'CVI Task Manager', username: 'Username', password: 'Password', login: 'Log in',
    loginFailed: 'Wrong username or password', logout: 'Log out', disabled: 'This account has been disabled',
    changePassword: 'Change password', newPassword: 'New password', save: 'Save', cancel: 'Cancel', saved: 'Saved',
    myTasks: 'My tasks', board: 'Task board', dashboard: 'Dashboard', presets: 'Presets', projects: 'Projects', people: 'People',
    newTask: 'New task', search: 'Search…', all: 'All', noTasks: 'No tasks here', showDone: 'Show completed',
    title: 'Title', description: 'Description', priority: 'Priority', dueDate: 'Due date', department: 'Department', project: 'Project',
    drawingLink: 'Drawing link', none: 'None', assignees: 'Assigned to', status: 'Status', files: 'Files', addFiles: 'Attach files',
    separate: 'Separate copy per person', shared: 'One shared task', create: 'Create',
    checklist: 'Checklist', addItem: 'Add item', itemText: 'Item text', required: 'Required', needsProof: 'Needs proof', uploadProof: 'Upload proof', viewProof: 'View proof',
    todo: 'To do', in_progress: 'In progress', review: 'Review', returned: 'Returned', done: 'Done',
    low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
    start: 'Start work', sendReview: 'Send to review', approve: 'Approve', returnTask: 'Return with comment', returnReason: 'Reason for returning', deleteTask: 'Delete task', confirmDelete: 'Delete this?',
    comments: 'Comments', addComment: 'Write a comment…', send: 'Send', readOnly: 'View only: this task is not assigned to you', late: 'Late',
    finishChecklist: 'Finish the required items (with proof) first',
    notifications: 'Notifications', noNotifications: 'No notifications', markRead: 'Mark all read',
    n_assigned: 'You were assigned a task', n_review: 'A task is waiting for your review', n_approved: 'Your task was approved', n_returned: 'Your task was returned', n_comment: 'New comment',
    n_completed: 'A task was finished', n_due_soon: 'Due soon', n_overdue: 'Late task', n_overdue_manager: 'A task in your department is late', n_morning: 'Today: {0}, coming up: {1}, late: {2}', n_weekly: 'This week: {0} finished, {1} late, {2} to review',
    installTitle: 'Install the app', installNow: 'Install now', installWhy: 'Install the app on your phone to open it in one tap and get notifications.', iosStep1: 'Open this link in Safari.', iosStep2: 'Tap the Share button at the bottom of the screen.', iosStep3: 'Choose Add to Home Screen, then Add.', iosStep4: 'Open the app from its new icon and log in.', iosVersion: 'Notifications need iOS 16.4 or newer.', androidStep1: 'Open this link in Chrome.', androidStep2: 'Tap the three dots at the top.', androidStep3: 'Choose Install app or Add to Home screen.',
    notifyAsk: 'Turn on notifications to hear about your tasks right away.', notifyInstallFirst: 'To get notifications on iPhone, install the app first.', notifyTurnOn: 'Turn on notifications', notifyTurnOff: 'Turn off notifications', notifyOn: 'Notifications are on', notifyOff: 'Notifications are off', notifyBlocked: 'Notifications are blocked. Allow them in your browser settings.',
    lateTasks: 'Late tasks', inReview: 'Waiting for review', openTasks: 'Open tasks', workload: 'Workload', person: 'Person', noLate: 'No late tasks',
    newPreset: 'New preset', daysUntilDue: 'Days until due', companyWide: 'Whole company', use: 'Use', edit: 'Edit', remove: 'Delete', repeat: 'Repeat',
    repeatNone: 'Once, now', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', firstRun: 'First run', repeating: 'Active repeats', stop: 'Stop', noPresets: 'No presets yet', created: 'Created',
    addProject: 'Add project', projectName: 'Project name', code: 'Code', deadline: 'Deadline', archive: 'Archive', noProjects: 'No projects yet',
    addPerson: 'Add person', fullName: 'Full name', role: 'Role', admin: 'Admin', manager: 'Manager', employee: 'Employee', active: 'Active', resetPassword: 'Reset password', deactivate: 'Disable', activate: 'Enable',
    usernameRule: 'English letters and numbers only', passwordRule: 'Password must be at least 6 characters', confirmOff: 'Account created but needs confirmation: turn off Confirm email in Supabase',
    departments: 'Departments', nameAr: 'Arabic name', nameEn: 'English name', addDepartment: 'Add department', error: 'Something went wrong',
    overview: 'Overview', hello: 'Hello', menu: 'Account', language: 'العربية', loginIntro: 'Log in with the username your admin gave you.', loginTag: 'Tasks, reviews and approvals in one place',
    today: 'Today', tomorrow: 'Tomorrow', dayLate: '1 day late', daysLate: '{n} days late', g_returned: 'Returned to you', g_late: 'Late', g_today: 'Today', g_week: 'Next 7 days', g_later: 'Later', g_nodate: 'No due date', g_done: 'Completed',
    allClear: 'Nothing on your list', allClearHint: 'New tasks appear here as soon as they are assigned to you.', sumNone: 'You have no open tasks.', sumOpen: 'You have {n} open tasks', sumLate: ', {n} late', sumToday: ', {n} due today',
    overviewClear: 'All clear: nothing to review and nothing late.', overviewSum: '{r} waiting for your review and {l} late, out of {o} open tasks.', needsReview: 'Waiting for your review', noReview: 'Nothing to review',
    nextStep: 'Next step', stepAssigned: 'Waiting for the assignee to start.', waitingReview: 'Sent for review. Waiting for a manager to decide.', stampDone: 'Approved', stampReturned: 'Returned', returnedBecause: 'Why it was returned', approvedOn: 'This task has been approved.',
    details: 'Details', more: 'More options', startFrom: 'Start from a preset', blank: 'Blank task', whatTitle: 'What needs doing?', whoTitle: 'Who will do it?', whenTitle: 'When?', inWeek: 'In a week', noDate: 'No date', searchPeople: 'Find a person…', pickAssignee: 'Choose at least one person', separateHint: 'Each person tracks their own task', sharedHint: 'Everyone works on the same task', optional: 'optional', createTask: 'Create task', createTasks: 'Create {n} tasks',
    noPresetsHint: 'Save work you repeat as a preset and create it in one click.', noProjectsHint: 'Add a project to link tasks to it.', items: 'items', dueIn: 'Due in {n} days', copy: 'Copy', copied: 'Copied', accountReady: 'The account is ready. Send these details to {name}:', done_btn: 'Done', inactive: 'Disabled', setPassword: 'Set a new password', savePreset: 'Save preset', noResults: 'No results', lateOnly: 'Late only',
    markDone: 'Mark done', reopen: 'Reopen', needsApproval: 'Needs a manager’s approval', needsApprovalHint: 'When off, the assignee finishes the task themselves', needsManager: 'This task needs a manager’s approval', fileTooBig: 'This file is over 10 MB. Add a link to it instead.',
    quickAddPlaceholder: 'Quickly add a task and press Enter…', quickForMe: 'Me', moreDetails: 'More details', forYourself: 'This task is for you. Your department manager can see it too.',
    searchAll: 'Search', paletteHint: 'Search for a task, person or project…', goTo: 'Go to', shortcuts: 'Ctrl+K to search, N for a new task, 1 to 7 to move around',
    columns: 'Columns', listView: 'List', selected: 'selected', reassign: 'Reassign', changeDate: 'Change date', changePriority: 'Change priority', clear: 'Clear', onlyManagerMove: 'You can’t move this task there',
    trash: 'Trash', trashHint: 'Tasks here are permanently deleted after 30 days.', trashEmpty: 'Trash is empty', restore: 'Restore', movedToTrash: 'Moved to trash', restored: 'Restored', deletedOn: 'Deleted',
    history: 'History', h_created: 'created the task', h_status: 'changed status to', h_due: 'changed the date to', h_priority: 'changed priority to', h_title: 'renamed it to', h_deleted: 'deleted the task', h_restored: 'restored the task', h_assigned: 'assigned', h_unassigned: 'unassigned',
    storage: 'File storage', storageUsed: '{used} of {total} used', storageWarn: 'File storage is almost full. Consider upgrading to the paid plan.', dbUpdate: 'The database needs updating: run patch-02-stage-1.sql in Supabase.',
  },
}
