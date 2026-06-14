// Client-side image resize/compress for the admin (e.g. marketing images).
// Downscale to a web-friendly JPEG before upload.
export function compressImage(file, maxDim = 1400, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      c.toBlob(b => b ? resolve(b) : reject(new Error('Could not process image')), 'image/jpeg', quality)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')) }
    img.src = url
  })
}
