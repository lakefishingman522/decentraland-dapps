import { ChainId } from '@dcl/schemas'
import { NavbarProps as NavbarComponentProps } from 'decentraland-ui'

export declare type WrongNetworkModalI18N = {
  wrongNetwork: {
    header: React.ReactNode
    message: React.ReactNode
  }
}

export type NavbarProps = NavbarComponentProps & {
  chainId: ChainId | undefined
  hasTranslations?: boolean
}

export type MapStateProps = Pick<
  NavbarProps,
  | 'mana'
  | 'address'
  | 'isConnected'
  | 'isConnecting'
  | 'hasTranslations'
  | 'chainId'
>

export type MapDispatchProps = {}
