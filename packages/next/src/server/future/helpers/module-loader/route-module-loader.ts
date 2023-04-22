import type { RouteModule } from '../../route-modules/route-module'
import type { ModuleLoader } from './module-loader'

import { NodeModuleLoader } from './node-module-loader'

interface LoadedRouteModule<M extends RouteModule = RouteModule> {
  routeModule?: M
}

export class RouteModuleLoader {
  public static load<M extends RouteModule>(
    id: string,
    loader: ModuleLoader = new NodeModuleLoader()
  ): M {
    if (process.env.NEXT_RUNTIME !== 'edge') {
      const { routeModule }: LoadedRouteModule<M> = loader.load(id)
      if (!routeModule) {
        throw new Error(
          `Invariant: "${id}" module can't be loaded or did not expose a routeModule`
        )
      }

      return routeModule
    }

    throw new Error('RouteModuleLoader is not supported in edge runtime.')
  }
}
