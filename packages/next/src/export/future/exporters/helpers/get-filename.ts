import { posix } from 'path'

export function getFilename() {
  const filePath = normalizePagePath(path)

  const getHtmlFilename = (_path: string) =>
    subFolders ? `${_path}${sep}index.html` : `${_path}.html`
  let htmlFilename = getHtmlFilename(filePath)

  // dynamic routes can provide invalid extensions e.g. /blog/[...slug] returns an
  // extension of `.slug]`
  const pageExt = isDynamic || isAppDir ? '' : posix.extname(page)
  const pathExt = isDynamic || isAppDir ? '' : posix.extname(path)

  // force output 404.html for backwards compat
  if (path === '/404.html') {
    htmlFilename = path
  }
  // Make sure page isn't a folder with a dot in the name e.g. `v1.2`
  else if (pageExt !== pathExt && pathExt !== '') {
    const isBuiltinPaths = ['/500', '/404'].some(
      (p) => p === path || p === path + '.html'
    )
    // If the ssg path has .html extension, and it's not builtin paths, use it directly
    // Otherwise, use that as the filename instead
    const isHtmlExtPath = !isBuiltinPaths && path.endsWith('.html')
    htmlFilename = isHtmlExtPath ? getHtmlFilename(path) : path
  } else if (path === '/') {
    // If the path is the root, just use index.html
    htmlFilename = 'index.html'
  }

  const baseDir = posix.join(outDir, posix.dirname(htmlFilename))
  let htmlFilepath = posix.join(outDir, htmlFilename)
}
