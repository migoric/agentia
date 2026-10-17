import type { Provider } from '@migor/agentia';
import LookupOrder from './tools/lookup-order/index.js';

/** 显式注册表 —— 形状与 `agentia g` 维护的一致（`{ provide: '<文件夹名>', useClass: <类> }`） */
export const providers: Provider[] = [{ provide: 'lookup-order', useClass: LookupOrder }];
