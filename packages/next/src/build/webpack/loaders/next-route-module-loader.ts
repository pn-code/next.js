import type webpack from 'webpack'
import type { PagesRouteModuleOptions } from '../../../server/future/route-modules/pages/module'

import { stringify } from 'querystring'

type NextRouteModuleLoaderOptions = {
  page: string
  kind: 'app-route' | 'pages'
  pathname: string
  filename: string

  dev: 'true' | 'false'
  config: string
  buildId: string
  absolute500Path: string
  absoluteAppPath: string
  absoluteDocumentPath: string
  absoluteErrorPath: string
}

export const getNextRouteModuleEntry = ({
  pages,
  dev,
  ...options
}: {
  dev: boolean
  config: string
  buildId: string
  page: string
  pages: { [page: string]: string }
  kind: 'app-route' | 'pages'
  pathname: string
  filename: string
}) => {
  const params: NextRouteModuleLoaderOptions = {
    ...options,
    dev: dev ? 'true' : 'false',
    absolute500Path: pages['/500'] || '',
    absoluteAppPath: pages['/_app'],
    absoluteDocumentPath: pages['/_document'],
    absoluteErrorPath: pages['/_error'],
  }

  return {
    import: `next-route-module-loader?${stringify(params)}!`,
  }
}

const loader: webpack.LoaderDefinitionFunction<NextRouteModuleLoaderOptions> =
  function (content) {
    const {
      dev,
      config,
      buildId,
      kind,
      pathname,
      filename,
      absolute500Path,
      absoluteAppPath,
      absoluteDocumentPath,
      absoluteErrorPath,
    } = this.getOptions()

    // This is providing the options defined by the route options type found at
    // ./routes/${kind}.ts. This is stringified here so that the literal for
    // `userland` can reference the variable for `userland` that's in scope for
    // the loader code.
    const options: Omit<PagesRouteModuleOptions, 'components' | 'userland'> = {
      renderOpts: {
        dev: dev === 'true',
        buildId,
        disableOptimizedLoading: false,
      },
      config: JSON.parse(config),
      pathname,
    }

    return `
      import RouteModule from 'next/dist/server/future/route-modules/${kind}/module'

      import * as userland from ${JSON.stringify(filename)}

      import * as moduleApp from ${JSON.stringify(absoluteAppPath)}
      import * as moduleDocument from ${JSON.stringify(absoluteDocumentPath)}

      const options = ${JSON.stringify(options)}
      const routeModule = new RouteModule({
        ...options,
        components: {
          App: moduleApp.default,
          Document: moduleDocument.default,
        },
        userland,
      })

      export { routeModule }
    `
  }

export default loader
