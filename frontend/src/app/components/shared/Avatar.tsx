import Image from 'next/image';
import styles from './Avatar.module.css';

// Profile photo when there is one, otherwise the first letter of the name on PinTool blue.
export default function Avatar({ name, src, size = 52, brand = false }: { name: string; src?: string; size?: number; brand?: boolean }) {
  return (
    <span className={`${styles.avatar} ${brand ? styles.brand : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42), borderRadius: Math.round(size * 0.27) }} aria-hidden="true">
      {src ? <Image src={src} alt="" width={size} height={size} unoptimized /> : (name.trim().slice(0, 1) || '?').toUpperCase()}
    </span>
  );
}
