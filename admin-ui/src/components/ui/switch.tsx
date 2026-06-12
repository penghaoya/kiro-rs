import * as React from 'react'
import * as SwitchPrimitives from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  /** sm：用于卡片角落等紧凑场景 */
  size?: 'default' | 'sm'
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, size = 'default', ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-apple',
      size === 'sm' ? 'h-[18px] w-[32px]' : 'h-[26px] w-[44px]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-input',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block rounded-full bg-white shadow-md ring-0 transition-transform duration-200 ease-apple data-[state=unchecked]:translate-x-0',
        size === 'sm'
          ? 'h-[14px] w-[14px] data-[state=checked]:translate-x-[14px]'
          : 'h-[22px] w-[22px] data-[state=checked]:translate-x-[18px]'
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
