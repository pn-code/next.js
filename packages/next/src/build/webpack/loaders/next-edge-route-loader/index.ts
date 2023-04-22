import { getModuleBuildInfo } from '../get-module-build-info'
import { stringifyRequest } from '../../stringify-request'
import { NextConfig } from '../../../../server/config-shared'
import { webpack } from 'next/dist/compiled/webpack/webpack'

export type EdgeRouteLoaderQuery = {
  absolutePagePath: string
  page: string
  appDirLoader: string
  nextConfigOutput: NextConfig['output']
  pagesType: 'app' | 'pages'
}

const EdgeRouteLoader: webpack.LoaderDefinitionFunction<EdgeRouteLoaderQuery> =
  async function (this) {
    const {
      page,
      absolutePagePath,
      appDirLoader: appDirLoaderBase64 = '',
      pagesType,
    } = this.getOptions()

    const appDirLoader = Buffer.from(appDirLoaderBase64, 'base64').toString()

    // Ensure we only run this loader for as a module.
    if (!this._module) throw new Error('This loader is only usable as a module')

    const buildInfo = getModuleBuildInfo(this._module)

    buildInfo.nextEdgeSSR = {
      isServerComponent: false,
      page: page,
      isAppDir: pagesType === 'app',
    }
    buildInfo.route = {
      page,
      absolutePagePath,
    }

    const stringifiedPagePath = stringifyRequest(this, absolutePagePath)
    const modulePath = `${appDirLoader}${stringifiedPagePath.substring(
      1,
      stringifiedPagePath.length - 1
    )}?__edge_ssr_entry__`

    console.log('also got here', modulePath)

    const mod = `
    import { EdgeRouteModuleWrapper } from 'next/dist/esm/server/web/edge-route-module-wrapper'
    import * as module from ${JSON.stringify(modulePath)}

    export const ComponentMod = module

    export default EdgeRouteModuleWrapper.wrap(module.routeModule)`

    console.log(mod)

    return mod
  }

export default EdgeRouteLoader
