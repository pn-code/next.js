import type { FontManifest, FontConfig } from '../server/font-utils'
import type {
  DomainLocale,
  ExportPathMap,
  NextConfigComplete,
} from '../server/config-shared'
import type { OutgoingHttpHeaders } from 'http'

// `NEXT_PREBUNDLED_REACT` env var is inherited from parent process,
// then override react packages here for export worker.
if (process.env.NEXT_PREBUNDLED_REACT) {
  require('../build/webpack/require-hook').overrideBuiltInReactPackages()
}

// Polyfill fetch for the export worker.
import '../server/node-polyfill-fetch'

import { loadRequireHook } from '../build/webpack/require-hook'

import { extname, join, sep } from 'path'
import fs from 'fs'
import AmpHtmlValidator from 'next/dist/compiled/amphtml-validator'
import { loadComponents } from '../server/load-components'
import { isDynamicRoute } from '../shared/lib/router/utils/is-dynamic'
import { normalizePagePath } from '../shared/lib/page-path/normalize-page-path'
import { requireFontManifest } from '../server/require'
import { normalizeLocalePath } from '../shared/lib/i18n/normalize-locale-path'
import { trace } from '../trace'
import { setHttpClientAndAgentOptions } from '../server/config'
import isError from '../lib/is-error'
import { normalizeAppPath } from '../shared/lib/router/utils/app-paths'
import {
  IncrementalCache,
  type CacheHandler,
} from '../server/lib/incremental-cache'
import { createRequestResponseMocks } from '../server/lib/mock-request'
import { isAppRouteRoute } from '../lib/is-app-route-route'
import { exportAppRouteRoute } from './future/exporters/export-app-route-route'
import { BatchedFileWriter } from './helpers/batched-file-writer'
import { exportAppPageRoute } from './future/exporters/export-app-page-route'
import { exportPagesRoute } from './future/exporters/export-pages-route'
import { ExportersResult } from './future/exporters/exporters'
import { interopDefault } from '../lib/interop-default'

loadRequireHook()

const envConfig = require('../shared/lib/runtime-config')

;(globalThis as any).__NEXT_DATA__ = {
  nextExport: true,
}

interface AmpValidation {
  page: string
  result: {
    errors: AmpHtmlValidator.ValidationError[]
    warnings: AmpHtmlValidator.ValidationError[]
  }
}

type PathMap = ExportPathMap[keyof ExportPathMap]

interface ExportPageInput {
  path: string
  pathMap: PathMap
  distDir: string
  outDir: string
  pagesDataDir: string
  renderOpts: RenderOpts
  buildExport?: boolean
  serverRuntimeConfig: { [key: string]: any }
  subFolders?: boolean
  optimizeFonts: FontConfig
  optimizeCss: any
  disableOptimizedLoading: any
  parentSpanId: any
  httpAgentOptions: NextConfigComplete['httpAgentOptions']
  serverComponents?: boolean
  enableUndici: NextConfigComplete['experimental']['enableUndici']
  debugOutput?: boolean
  isrMemoryCacheSize?: NextConfigComplete['experimental']['isrMemoryCacheSize']
  fetchCache?: boolean
  incrementalCacheHandlerPath?: string
  fetchCacheKeyPrefix?: string
  nextConfigOutput?: NextConfigComplete['output']
}

export interface ExportPageResults {
  ampValidations?: AmpValidation[]
  fromBuildExportRevalidate?: number | false
  fromBuildExportMeta?: {
    status?: number
    headers?: OutgoingHttpHeaders
  }
  error?: boolean
  ssgNotFound?: boolean
  duration: number
}

export interface RenderOpts {
  runtimeConfig?: { [key: string]: any }
  params?: { [key: string]: string | string[] }
  ampPath?: string
  ampValidatorPath?: string
  ampSkipValidation?: boolean
  optimizeFonts?: FontConfig
  disableOptimizedLoading?: boolean
  optimizeCss?: any
  fontManifest?: FontManifest
  locales?: string[]
  locale?: string
  defaultLocale?: string
  domainLocales?: DomainLocale[]
  trailingSlash?: boolean
  supportsDynamicHTML?: boolean
  incrementalCache?: IncrementalCache
  strictNextHead?: boolean
}

// expose AsyncLocalStorage on globalThis for react usage
const { AsyncLocalStorage } = require('async_hooks')
;(globalThis as any).AsyncLocalStorage = AsyncLocalStorage

export default async function exportPage({
  parentSpanId,
  path,
  pathMap,
  distDir,
  outDir,
  pagesDataDir,
  renderOpts,
  buildExport,
  serverRuntimeConfig,
  subFolders,
  optimizeFonts,
  optimizeCss,
  disableOptimizedLoading,
  httpAgentOptions,
  serverComponents,
  enableUndici,
  debugOutput,
  isrMemoryCacheSize,
  fetchCache,
  fetchCacheKeyPrefix,
  incrementalCacheHandlerPath,
}: ExportPageInput): Promise<ExportPageResults> {
  setHttpClientAndAgentOptions({
    httpAgentOptions,
    experimental: { enableUndici },
  })

  // Create the batched writer that can be used to write all the files to disk
  // that were generated during the export of this page.
  const writer = new BatchedFileWriter()
  const start = Date.now()

  const results = await trace('export-page-worker', parentSpanId).traceAsyncFn(
    async (): Promise<ExportersResult | null> => {
      try {
        const { query: originalQuery = {} } = pathMap
        const { page } = pathMap
        const pathname = normalizeAppPath(page)
        const isAppDir = pathMap._isAppDir === true
        const isDynamicError = pathMap._isDynamicError === true
        const filePath = normalizePagePath(path)
        const isDynamic = isDynamicRoute(page)
        const ampPath = `${filePath}.amp`
        let renderAmpPath = ampPath
        const query = { ...originalQuery }
        let params: { [key: string]: string | string[] } | undefined
        const isRouteHandler = isAppDir && isAppRouteRoute(page)

        if (isAppDir) {
          outDir = join(distDir, 'server/app')
        }

        // We need to show a warning if they try to provide query values
        // for an auto-exported page since they won't be available
        const hasOrigQueryValues = Object.keys(originalQuery).length > 0
        const queryWithAutoExportWarn = () => {
          if (hasOrigQueryValues) {
            throw new Error(
              `\nError: you provided query values for ${path} which is an auto-exported page. These can not be applied since the page can no longer be re-rendered on the server. To disable auto-export for this page add \`getInitialProps\`\n`
            )
          }
        }

        // Check if the page is a specified dynamic route
        const nonLocalizedPath = normalizeLocalePath(
          path,
          renderOpts.locales
        ).pathname

        const { req, res } = createRequestResponseMocks({ url: updatedPath })

        if (renderOpts.trailingSlash && !req.url.endsWith('/')) {
          req.url += '/'
        }

        envConfig.setConfig({
          serverRuntimeConfig,
          publicRuntimeConfig: renderOpts.runtimeConfig,
        })

        const getHtmlFilename = (_path: string) =>
          subFolders ? `${_path}${sep}index.html` : `${_path}.html`
        let htmlFilename = getHtmlFilename(filePath)

        // dynamic routes can provide invalid extensions e.g. /blog/[...slug] returns an
        // extension of `.slug]`
        const pageExt = isDynamic || isAppDir ? '' : extname(page)
        const pathExt = isDynamic || isAppDir ? '' : extname(path)

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

        const htmlFilepath = join(outDir, htmlFilename)
        let curRenderOpts: RenderOpts = {}

        if (!isRouteHandler) {
          const components = await loadComponents({
            distDir,
            pathname: page,
            hasServerComponents: !!serverComponents,
            isAppPath: isAppDir,
          })

          curRenderOpts = {
            ...components,
            ...renderOpts,
            strictNextHead: !!renderOpts.strictNextHead,
            ampPath: renderAmpPath,
            params,
            optimizeFonts,
            optimizeCss,
            disableOptimizedLoading,
            fontManifest: optimizeFonts ? requireFontManifest(distDir) : null,
            supportsDynamicHTML: false,
          }
        }

        // Ensure that the url for the page is absolute.
        req.url = `http://localhost:3000${req.url}`
        // const request = NextRequestAdapter.fromNodeNextRequest(
        //   new NodeNextRequest(req)
        // )

        // during build we attempt rendering app dir paths
        // and bail when dynamic dependencies are detected
        // only fully static paths are fully generated here
        if (isAppDir) {
          let incrementalCache: IncrementalCache | undefined

          if (fetchCache) {
            // Load the cache handler from configuration if it's provided.
            let CurCacheHandler: typeof CacheHandler | undefined
            if (incrementalCacheHandlerPath) {
              CurCacheHandler = interopDefault(
                require(incrementalCacheHandlerPath)
              )
            }

            // Create the incremental cache instance.
            incrementalCache = new IncrementalCache({
              dev: false,
              requestHeaders: {},
              flushToDisk: true,
              fetchCache: true,
              maxMemoryCacheSize: isrMemoryCacheSize,
              fetchCacheKeyPrefix,
              getPrerenderManifest: () => ({
                version: 4,
                routes: {},
                dynamicRoutes: {},
                preview: {
                  previewModeEncryptionKey: '',
                  previewModeId: '',
                  previewModeSigningKey: '',
                },
                notFoundRoutes: [],
              }),
              fs: {
                readFile: (f) => fs.promises.readFile(f),
                readFileSync: (f) => fs.readFileSync(f),
                writeFile: (f, d) => fs.promises.writeFile(f, d),
                mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
                stat: (f) => fs.promises.stat(f),
              },
              serverDistDir: join(distDir, 'server'),
              CurCacheHandler,
            })

            // Bind the cache to the globalThis so it can be accessed by the
            // static generation storage handler.
            ;(globalThis as any).__incrementalCache = incrementalCache
            curRenderOpts.incrementalCache = incrementalCache
          }

          if (isRouteHandler) {
            return await exportAppRouteRoute({
              path,
              distDir,
              page,
              incrementalCache,
              writer,
              htmlFilepath,
            })
          }

          return await exportAppPageRoute({
            curRenderOpts,
            page,
            req,
            res,
            pathname,
            query,
            writer,
            htmlFilepath,
            isDynamicError,
            path,
            debugOutput,
          })
        }

        return await exportPagesRoute({
          pathname: path,
          query,
          page,
          distDir,
          renderOpts: {
            defaultLocale: renderOpts.defaultLocale,
            locale: renderOpts.locale,
            domainLocales: renderOpts.domainLocales,
            trailingSlash: renderOpts.trailingSlash,
          },
          buildExport: buildExport === true,
          req,
          res,
          writer,
          htmlFilename,
          htmlFilepath,
          pagesDataDir,
        })
      } catch (error) {
        return { type: 'error', error }
      }
    }
  )

  // Flush the file writes to disk.
  await writer.flush()

  const duration = Date.now() - start

  // Transform the results into the expected format.
  switch (results?.type) {
    case 'error':
      // Log the error if this export failed due to an error.
      const { error } = results
      console.error(
        `\nError occurred prerendering page "${path}". Read more: https://nextjs.org/docs/messages/prerender-error\n` +
          (isError(error) && error.stack ? error.stack : error)
      )

      return {
        fromBuildExportRevalidate: 0,
        error: true,
        duration,
      }
    case 'built':
      return {
        // TODO: (wyattjoh) add amp validation results
        ampValidations: [],
        fromBuildExportRevalidate: results.revalidate,
        fromBuildExportMeta: results.metadata,
        duration,
      }
    case 'not-found':
      return {
        ssgNotFound: true,
        fromBuildExportRevalidate: 0,
        duration,
      }
    default:
      // TODO: (wyattjoh) maybe we don't need this?
      return {
        duration,
      }
  }
}
