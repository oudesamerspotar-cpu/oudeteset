/** GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية) */
const { LIMITS, VERSION } = require("../lib/env");
const { sendJson } = require("../lib/respond");

module.exports = async (req, res) => {
  void req;
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    limits: {
      maxSources: LIMITS.MAX_SOURCES,
      sourceMaxMB: LIMITS.SOURCE_MAX_MB,
      outputMaxMB: LIMITS.OUTPUT_MAX_MB,
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
      blobRowBytes: LIMITS.BLOB_ROW_BYTES,
      jobTtlHours: LIMITS.JOB_TTL_HOURS,
      // العرض الصوري (صور ← فيديو رأسي بتحريك خفيف)
      slideshowMinImages: LIMITS.SLIDESHOW_MIN_IMAGES,
      slideshowMaxImages: LIMITS.SLIDESHOW_MAX_IMAGES,
      slideshowImageMaxMB: LIMITS.SLIDESHOW_IMAGE_MAX_MB,
      slideshowClipSeconds: LIMITS.SLIDESHOW_CLIP_SEC,
      slideshowResolution: `${LIMITS.SLIDESHOW_WIDTH}x${LIMITS.SLIDESHOW_HEIGHT}`,
      slideshowFps: LIMITS.SLIDESHOW_FPS,
    },
    output: { codec: "H.264 (libx264 CRF 18) + AAC 192k/44100Hz", container: "MP4 (+faststart)", maxResolution: "1920x1080" },
  });
};
