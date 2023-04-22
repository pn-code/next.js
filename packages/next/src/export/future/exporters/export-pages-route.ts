import type PagesRouteModule from '../../../server/future/route-modules/pages/module'
import type { PagesRouteHandlerContext } from '../../../server/future/route-modules/pages/module'
import type { IncomingMessage, ServerResponse } from 'http'
import type { NextRequest } from '../../../server/web/spec-extension/request'
import type { ExportersResult } from './exporters'
import type { BatchedFileWriter } from '../../helpers/batched-file-writer'

import { posix } from 'path'
import { RouteModuleLoader } from '../../../server/future/helpers/module-loader/route-module-loader'
import { SERVER_DIRECTORY } from '../../../shared/lib/constants'
import { RenderOpts } from '../../worker'
import { ManifestLoader } from '../../../server/future/route-modules/pages/helpers/load-manifests'
import {
  NextParsedUrlQuery,
  addRequestMeta,
} from '../../../server/request-meta'
import { normalizeLocalePath } from '../../../shared/lib/i18n/normalize-locale-path'
import { normalizePagePath } from '../../../shared/lib/page-path/normalize-page-path'
import { isDynamicRoute } from '../../../shared/lib/router/utils'
import { getParams } from '../helpers/get-params'
import { NodeNextRequest } from '../../../server/base-http/node'
import { MockedRequest, MockedResponse } from '../../../server/lib/mock-request'
import { NextRequestAdapter } from '../../../server/web/spec-extension/adapters/next-request'
import { getStatusCode } from '../helpers/get-status-code'

type ExportPagesRouteRenderOpts = Pick<
  RenderOpts,
  | 'runtimeConfig'
  | 'locales'
  | 'defaultLocale'
  | 'locale'
  | 'domainLocales'
  | 'trailingSlash'
>

type ExportPagesRouteContext = {
  page: string
  pathname: string
  query: NextParsedUrlQuery
  distDir: string
  buildExport: boolean
  req: IncomingMessage
  res: ServerResponse
  writer: BatchedFileWriter
  htmlFilename: string
  htmlFilepath: string
  pagesDataDir: string
  renderOpts: ExportPagesRouteRenderOpts
}

export async function exportPagesRoute({
  pathname,
  query,
  distDir,
  page,
  buildExport,
  writer,
  htmlFilename,
  htmlFilepath,
  pagesDataDir,
  renderOpts,
}: ExportPagesRouteContext): Promise<ExportersResult | null> {
  const normalizedPath = normalizePagePath(pathname)

  /**
   * Represents the internal pathname used for routing.
   */
  let updatedPath = query.__nextSsgPath || pathname
  delete query.__nextSsgPath

  // For AMP support, we need to render the AMP version of the page.
  const ampPath = `${normalizedPath}.amp`

  // The path that users navigate to when they want to get to that page. Later
  // this may remove the locale prefix if the locale is the default locale.
  let renderAmpPath = ampPath

  // Default the locale.
  let locale = query.__nextLocale || renderOpts.locale
  delete query.__nextLocale

  // If a locale has been indicated on the request, then try to normalize the
  // path to remove the locale part.
  if (renderOpts.locale) {
    const result = normalizeLocalePath(pathname, renderOpts.locales)
    if (result.detectedLocale) {
      // Update the pathname to exclude the locale and save the detected locale.
      updatedPath = result.pathname
      locale = result.detectedLocale

      // If the detected locale is the same as the default locale, we should use
      // the stripped path as the AMP path.
      if (locale === renderOpts.defaultLocale) {
        renderAmpPath = `${normalizePagePath(updatedPath)}.amp`
      }
    }
  }

  // Create the mocked request. This looks really bad, but these wrappers will
  // convert the MockedRequest to a NodeNextRequest to a NextRequest.
  const req = new MockedRequest({
    method: 'GET',
    url: `https://localhost:3000${updatedPath}`,
    headers: {},
  })

  // Add the trailing slash if it's missing and required.
  if (renderOpts.trailingSlash && !updatedPath.endsWith('/')) {
    req.url += '/'
  }

  // Create the mocked response.
  const res = new MockedResponse()

  // Try to get the status code from the pathname. If the pathname has a locale
  // and we can't find a direct match with the updated path, then try to see if
  // this is a match for the locale, otherwise, default to 200.
  res.statusCode =
    getStatusCode(updatedPath) ?? locale
      ? getStatusCode(`/${locale}${updatedPath}`) ?? 200
      : 200

  const isLocaleDomain: boolean =
    buildExport &&
    Boolean(locale) &&
    Array.isArray(renderOpts.domainLocales) &&
    renderOpts.domainLocales.some(
      (dl) => dl.defaultLocale === locale || dl.locales?.includes(locale || '')
    )
  if (isLocaleDomain) {
    addRequestMeta(req, '__nextIsLocaleDomain', true)
  }

  const request = NextRequestAdapter.fromNodeNextRequest(
    new NodeNextRequest(req)
  )

  // If the rout is dynamic, get the params from the path.
  const params =
    // If the page is a dynamic route and the request path is not the same as
    // the page, then get the parameters.
    isDynamicRoute(page) && page !== updatedPath
      ? getParams(page, updatedPath)
      : false
  if (params) {
    // Merge the params into the query.
    query = { ...query, ...params }
  }

  const context: PagesRouteHandlerContext = {
    params: query,
    export: true,
    manifests: ManifestLoader.load({ distDir }),
    renderOpts: {
      query,
      page,
      ampPath,
      customServer: undefined,
      distDir,
      isDataReq: false,
      resolvedAsPath: undefined,
      // FIXME: (wyattjoh) this is mirroring the behavior of renderToHTML
      resolvedUrl: undefined as unknown as string,
      err: undefined,
      runtime: undefined,
      runtimeConfig: renderOpts.runtimeConfig,
      locale,
      locales: renderOpts.locales,
      defaultLocale: renderOpts.defaultLocale,
      isLocaleDomain,
    },
  }

  // This is a route handler, which means it has it's handler in the
  // bundled file already, we should just use that.
  const filename = posix.join(distDir, SERVER_DIRECTORY, 'pages', page)

  // Load the module for the route.
  const module = RouteModuleLoader.load<PagesRouteModule>(filename)

  // Validate the module. If it doesn't error here, then it _could_ be
  // pre-rendered.
  module.setup(page, true, false)

  // For non-dynamic routes that have getStaticProps we should have already
  // pre-rendered the page.
  if (!buildExport && module.userland.getStaticProps && !module.isDynamic) {
    return null
  }

  // Render the page using the module.
  const result = await module.render(request, {
    ...context,
    req,
    res,
    previewData: undefined,
    isPreviewMode: false,
  })

  const metadata = result.metadata()

  // If the status code isn't 200, we should bail out.
  if (metadata.isNotFound || metadata.isRedirect || !result.body) {
    return { type: 'not-found' }
  }

  // As we now have verified that the result of the module being executed
  // is not a redirect or a 404, we can now safely write the file to disk.
  const html = result.toUnchunkedString()

  // Write the HTML file to disk.
  writer.write(htmlFilepath.replace(/\.html$/, '.html'), html, 'utf8')

  // Write the static props file to disk if it exists.
  if (metadata.pageData) {
    writer.write(
      posix.join(pagesDataDir, htmlFilename).replace(/\.html$/, '.json'),
      JSON.stringify(metadata.pageData)
    )
  }

  // FIXME: (wyattjoh) add AMP support

  return { type: 'built', revalidate: metadata.revalidate }
}
