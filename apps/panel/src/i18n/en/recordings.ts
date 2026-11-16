const recordings = {
  "title": "Recording retention",
  "lead": "New recordings are encrypted on disk and in the MinIO/S3 copy. The default is 90 days with automatic daily deletion. We do not extract voiceprints or perform voice biometrics.",
  "days": "Keep audio for (days)",
  "hint": "From 90 to 3650 days. Audio retention is independent of transcripts.",
  "save": "Save audio retention",
  "confirm": "Delete recordings older than {days} days?",
  "confirmBody": "Deleted audio cannot be recovered. Deletion also covers the MinIO/S3 copy; external backups must follow the same period.",
  "yes": "Confirm audio deletion",
  "cancel": "Cancel"
};
export default recordings;
