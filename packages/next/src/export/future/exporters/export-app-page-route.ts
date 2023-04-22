import type {
  MockedRequest,
  MockedResponse,
} from '../../../server/lib/mock-request'
import type { RenderOpts } from '../../worker'
import type { BatchedFileWriter } from '../../helpers/batched-file-writer'
import type { ExportersResult } from './exporters'

import { isDynamicUsageError } from '../helpers/is-dynamic-usage-error'
import { NextParsedUrlQuery } from '../../../server/request-meta'

type ExportAppPageRouteContext = {
  curRenderOpts: RenderOpts
  page: string
  req: MockedRequest
  res: MockedResponse
  pathname: string
  query: NextParsedUrlQuery
  writer: BatchedFileWriter
  htmlFilepath: string
  isDynamicError: any
  path: string
  debugOutput: boolean | undefined
}

export async function exportAppPageRoute({
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
}: ExportAppPageRouteContext): Promise<ExportersResult | null> {
  const { renderToHTMLOrFlight } =
    require('../../server/app-render/app-render') as typeof import('../../../server/app-render/app-render')

  try {
    // Ensure that params is set.
    curRenderOpts.params ||= {}

    // This is applied in the webpack loader.
    const isNotFoundPage = page === '/_not-found'

    // Render the page.
    const result = await renderToHTMLOrFlight(
      req,
      res,
      isNotFoundPage ? '/404' : pathname,
      query,
      // FIXME: (wyattjoh) this is the current behavior, should be fixed with app page route module adoption
      curRenderOpts as any
    )

    const html = result.toUnchunkedString()
    const metadata = result.metadata()

    // This is the `export const dynamic = 'error'` case, this should be
    // improved with the app page route module adoption.
    if (isDynamicError) {
      throw new Error(
        `Page with dynamic = "error" encountered dynamic data method on ${path}.`
      )
    }

    if (metadata.revalidate !== 0) {
      writer.write(htmlFilepath, html ?? '', 'utf8')
      writer.write(htmlFilepath.replace(/\.html$/, '.rsc'), metadata.pageData)
    }

    // Warn about static generation failures when debug is enabled.
    if (
      debugOutput &&
      metadata.revalidate === 0 &&
      metadata.staticBailoutInfo?.description
    ) {
      const err = new Error(
        `Static generation failed due to dynamic usage on ${path}, reason: ${metadata.staticBailoutInfo.description}`
      )
      const stack = metadata.staticBailoutInfo.stack

      if (stack) {
        err.stack = err.message + stack.substring(stack.indexOf('\n'))
      }

      console.warn(err)
    }

    return { type: 'built', revalidate: metadata.revalidate }
  } catch (err) {
    // If this isn't a dynamic usage error, we should throw it.
    if (!isDynamicUsageError(err)) {
      return { type: 'error', error: err }
    }

    return null
  }
}
