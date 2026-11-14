# خدمة دمج الفيديوهات — Video Merger API

موقع كامل لدمج الفيديوهات مع **واجهة برمجية عامة (API)** للمطورين، جاهز للنشر على Vercel:
- **Node.js خالص (CommonJS)** بلا Next.js/React ولا خطوة بناء: واجهة ثابتة (HTML+CSS+JS في ملف واحد) في `public/` + دوال Vercel Serverless في `api/`.
- **Turso (libSQL) عبر HTTP** تُخزَّن فيها كل شيء: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — لا S3 ولا خدمات خارجية.
- **ffmpeg + ffprobe** داخل الدالة نفسها (حزم `ffmpeg-static` / `ffprobe-static` مع سقوط آمن إلى ثنائيات النظام محليًا).
- مخرجات عالية الجودة إلزامية: **MP4 (H.264 CRF 18 + AAC 192k/44100Hz + +faststart)** حتى 1080p — بلا معاملات resolution/fps (الناتج ثابت).

## الحدود

| الحد | القيمة | متغير البيئة |
|---|---|---|
| عدد المقاطع | 10 كحد أقصى | `MAX_SOURCES=10` |
| حجم كل مصدر | 200MB | `SOURCE_MAX_MB=200` |
| حجم الناتج | 150MB | `OUTPUT_MAX_MB=150` |
| مجموع مدد المقاطع | 600 ثانية | `MAX_TOTAL_DURATION_SEC=600` |
| عمر المهمة والناتج | **24 ساعة ثم حذف تلقائي** | ثابت |
| أجزاء الرفع | 4MB لكل POST ثنائي (حد Vercel ≈4.5MB) | ثابت |
| صفوف التخزين | كل Blob يُقسَّم لصفوف 2MB وتُقرأ بصفحات من 8 صفوف | ثابت |

## محرك الدمج

- ffprobe لكل مصدر: الدقة، المدة، وجود الصوت.
- توحيد كل المصادر عبر `filter_complex`: `scale + pad` إلى أكبر دقة بين المدخلات (سقف 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p` ثم `concat`.
- مصدر بلا صوت → مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- الترميز: `libx264 CRF 18 + AAC 192k + +faststart` — الـ preset من `FFMPEG_PRESET`.
- التقدم الحي: قراءة `out_time_us` من `-progress pipe:1` وتخزين النسبة (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).
- ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة → `ensureExecutable` ينسخه إلى `/tmp` بصلاحية 755 عند الحاجة.
- الحدود تُفحص قبل وأثناء العمل — تجاوز أي حد = فشل واضح برسالة عربية وليس انهيارًا.

## واجهة API العامة (بدون تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version (فحص الجهوزية) |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي في `vercel.json`) |

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version (فحص الجهوزية) |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي في `vercel.json`) |

### العرض الصوري — صور ← فيديو رأسي 9:16 بتحريك خفيف (بلا أي API مدفوع)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/slideshow` | إنشاء مهمة عرض صوري: `{"images":["url",...]}` روابط مباشرة أو `{"sources":[{"kind":"file","name","size","mime"},...]}` لرفع ملفات. اختياري: `"clip_seconds": 5..20` (افتراضي 15). القيود: 4–8 صور، ≤ SLIDESHOW_IMAGE_MAX_MB لكل صورة |
| `POST` | `/api/slideshow/<id>/clip?seq=<k>` | معالجة الصورة رقم k: مقطع 15 ثانية رأسي 720×1280 @ 24fps بتقريب/تحريك خفيف (Ken Burns) + وهج دخول/خروج — يخزَّن في Turso |
| `POST` | `/api/slideshow/<id>/merge` | دمج المقاطع في فيديو MP4 واحد عبر محوّل concat مع `-c copy` (بلا إعادة ترميز — ثوانٍ معدودة) |
| `GET` | `/api/slideshow/<id>` | حالة تفصيلية: الصور الجاهزة/المتبقية + روابط الخطوات + الناتج عند الاكتمال |
| `DELETE` | `/api/slideshow/<id>` | حذف شامل (نفس حذف مهام الدمج) |

الناتج النهائي يُبَث ويُنزَّل من نفس نقاط الدمج: `GET /api/jobs/<id>/video` و`?download=1`.
التقدم الكلي: رفع 0–39٪ → مقاطع 40–90٪ → دمج 90–100٪. تنفيذ كل صورة في استدعاء مستقل يُبقي كل نداء داخل مهلة دالة Vercel (60 ثانية على الخطة المجانية — الدقة 720×1280 مضبوطة لهذا السبب، ويمكن رفعها بمتغيرات `SLIDESHOW_WIDTH`/`SLIDESHOW_HEIGHT`).

```bash
# 1) إنشاء مهمة عرض صوري من روابط
curl -X POST https://<دومينك>/api/slideshow \
  -H "Content-Type: application/json" \
  -d '{"images":["https://example.com/1.jpg","https://example.com/2.jpg","https://example.com/3.jpg","https://example.com/4.jpg"]}'
# → 201 {"jobId":"...","imageCount":4,"clipSeconds":15,"clipUrl":".../clip?seq=<k>","mergeUrl":".../merge",...}

# 2) معالجة كل صورة بالترتيب (كل استدعاء ~3–40 ثانية حسب قدرة المعالج)
curl -X POST "https://<دومينك>/api/slideshow/<id>/clip?seq=0"
# → {"ok":true,"seq":0,"clipsReady":1,"totalImages":4,"progress":52,"remaining":[1,2,3],...}

# 3) بعد اكتمال كل المقاطع: الدمج النهائي
curl -X POST "https://<دومينك>/api/slideshow/<id>/merge"
# → {"status":"done","videoUrl":"https://<دومينك>/api/jobs/<id>/video","downloadUrl":"...?download=1",
#    "duration":60.0,"resolution":"720x1280","size":4567890}
```

| متغير البيئة (اختياري) | الافتراضي | الوظيفة |
|---|---|---|
| `SLIDESHOW_MIN_IMAGES` / `SLIDESHOW_MAX_IMAGES` | 4 / 8 | حدود عدد الصور |
| `SLIDESHOW_IMAGE_MAX_MB` | 15 | حد حجم الصورة الواحدة |
| `SLIDESHOW_CLIP_SEC` | 15 | مدة مقطع كل صورة (قابلة للتجاوز لكل مهمة بـ `clip_seconds` 5–20) |
| `SLIDESHOW_WIDTH` / `SLIDESHOW_HEIGHT` | 720 / 1280 | مقاس الناتج (رأسي 9:16) |
| `SLIDESHOW_FPS` | 24 | معدل الإطارات |
| `SLIDESHOW_PRESET` / `SLIDESHOW_CRF` | veryfast / 20 | سرعة/جودة ترميز libx264 |

### أمثلة curl (الدمج العادي)

```bash
# 1) إنشاء مهمة من روابط مباشرة
curl -X POST https://<دومينك>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
# → 201 {"jobId":"wkucdefoxwvd","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 1ب) مهمة ملفات: ترسل وصف المصادر وترفع الأجزاء لاحقًا
curl -X POST https://<دومينك>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"file","name":"clip.mp4","size":123456,"mime":"video/mp4"},{"kind":"url","url":"https://example.com/b.mp4"}]}'
# → 201 مع uploads[] برابط رفع لكل مصدر + uploadChunkBytes

# 2) رفع ملف بأجزاء 4MB (Content-Type: application/octet-stream) — الجزء قابل لإعادة الرفع عند فشل الشبكة
curl -X POST "https://<دومينك>/api/upload?job=<id>&seq=0&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @chunk0.bin

# 3) تنفيذ الدمج (متزامن ~10–15 ثانية؛ لو كانت قيد المعالجة فعله يرد 202)
curl -X POST https://<دومينك>/api/jobs/<id>/process
# → 200 {"status":"done","videoUrl":"https://<دومينك>/api/jobs/<id>/video",
#        "downloadUrl":"...?download=1","size":1234567,"duration":30.2,"resolution":"1280x720","expiresAt":"..."}

# 4) الحالة والتقدم
curl https://<دومينك>/api/jobs/<id>
# → {"status":"done","progress":100,"videoUrl":"...","size":...,"duration":...,"resolution":"WxH"}

# 5) البث بدعم Range (206) والتحميل
curl -H "Range: bytes=0-999" -o part.bin https://<دومينك>/api/jobs/<id>/video
curl -o merged.mp4 "https://<دومينك>/api/jobs/<id>/video?download=1"

# 6) حذف شامل فوري
curl -X DELETE https://<دومينك>/api/jobs/<id>
```

### أكواد الأخطاء
`400` مدخلات تالفة/JSON غير صالح • `404` غير موجود • `405` طريقة خاطئة • `409` حالة غير مناسبة (مهمة قيد المعالجة/فاشلة) • `413` تجاوز الحجم • `500` فشل تنفيذ الدمج (مع رسالة السبب).

## التخزين والحذف التلقائي

- جداول: `jobs`، `sources`، `source_chunks`، `output_chunks`، `clip_chunks` (مقاطع العرض الصوري الوسيطة) — تُنشأ بـ `CREATE TABLE IF NOT EXISTS` بمفاتيح مركبة، مع ترحيل تلقائي يضيف عمودي `type` (merge/slideshow) و`params_json` لقاعدة قائمة.
- كل Blob يُقسَّم لصفوف 2MB (حد عملي لحجم طلب Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف مع تقليم أول/آخر جزء حسب المدى المطلوب (Range 206).
- `expires_at = created_at + 24 ساعة`؛ التنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` مجدولة يوميًا في `vercel.json`.
- DELETE يحذف كل صفوف المهمة في batch واحد، وبعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.
- لا اعتماد على نظام ملفات دائم — `/tmp` فقط أثناء المعالجة ويُنظف في `finally`.

## اختبارات مسلَّمة (44/44)

```bash
bun install        # ثم (اختياري محليًا) node server.js على :4000
npm test           # scripts/test-unit.js ثم scripts/test-http.js
```

- **وحدات 16/16**: توليد فيديوهين مختلفي الدقة بـ ffmpeg → دمج → الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت (مصدر صامت → anullsrc)، H.264 داخل MP4، حدود العدد، تخزين Turso واسترجاع sha256 مطابق، مسار أجزاء الرفع (4MB → صفوف 2MB)، رفض تجاوز حجم أثناء التنزيل، الحذف الشامل.
- **HTTP 28/28**: config، إنشاء من روابط، رفض 11 مقطعًا، مهمة مختلطة (رابط + ملف مرفوع بأجزاء)، دمج → done، بث كامل 200 + Range 206 + download=1، DELETE → 404 بعد الحذف، JSON تالف → 400، قائمة فارغة → 400، طريقة خاطئة → 405.

## النشر على Vercel خطوة بخطوة

1. **إنشاء قاعدة Turso والحصول على التوكن**
   ```bash
   turso db create <اسم-القاعدة>
   turso db show <اسم-القاعدة> --url      # هذا TURSO_DATABASE_URL (libsql://...)
   turso db tokens create <اسم-القاعدة>   # هذا TURSO_AUTH_TOKEN
   ```
2. **رفع المستودع** إلى GitHub (`.env` مستثنى في `.gitignore` — لا ترفع أسرارًا).
3. **ربط Vercel**: New Project → اختر المستودع → Framework Preset: Other (لا خطوة بناء).
4. **متغيرات البيئة** في Project → Settings → Environment Variables (Production + Preview):
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان)
   - اختياري: `MAX_SOURCES`، `SOURCE_MAX_MB`، `OUTPUT_MAX_MB`، `MAX_TOTAL_DURATION_SEC`، `FFMPEG_PRESET`
5. **Deploy** — `vercel.json` يضبط `maxDuration: 300` لكل الدوال و cron يومي على `/api/cron`.
6. **التجريب بعد النشر**: نفس أمثلة curl أعلاه بدومينك، وافحص الجهوزية بـ `curl https://<دومينك>/api/config`.

## حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة على الخطة المجانية | الأثر هنا |
|---|---|---|
| مدة الدالة (Hobby) | حتى 60 ثانية | `maxDuration: 300` يتطلب **Pro**؛ على Hobby قلّص المدد أو قسّم الدمج |
| حجم الطلب | ≈ 4.5MB | الرفع أجزاء 4MB مع إعادة محاولة ×3 (منفذ في الواجهة) |
| قاعدة Turso المجانية | 5GB تخزين + 500 قاعدة | النواتج تُحذف تلقائيًا بعد 24 ساعة فلا تتراكم |
| تنفيذ ffmpeg | معالج مشترك | الدمج الطويل قد يستغرق دقائق — راقب التقدم من `/api/jobs/<id>` |

## الواجهة (public/index.html)

حقل روابط + منطقة سحب وإفلات + قائمة قابلة لإعادة الترتيب (سحب أو ↑↓) مع ترقيم واضح = ترتيب الدمج، زر دمج ينفذ التدفق كاملًا (إنشاء → رفع أجزاء 4MB مع إعادة محاولة ×3 → تنفيذ → عرض) مع شريط تقدم حقيقي من الخادم، صفحة نتيجة (مشغل + حجم/مدة/دقة + تحميل + نسخ + عدّاد تنازلي 24 ساعة)، استئناف العرض بعد تحديث الصفحة عبر `#job=<id>`، وقسم توثيق API قابل للطي بأمثلة curl بالدومين الحقيقي.
