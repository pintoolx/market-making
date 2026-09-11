'use client';

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import styles from './PageTransition.module.css';

interface PageTransitionProps {
  children: React.ReactNode;
}

export default function PageTransition({ children }: PageTransitionProps) {
  const pathname = usePathname();
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [displayChildren, setDisplayChildren] = useState(children);

  useEffect(() => {
    setIsTransitioning(true);
    
    const timer = setTimeout(() => {
      setDisplayChildren(children);
      setIsTransitioning(false);
    }, 150);

    return () => clearTimeout(timer);
  }, [pathname, children]);

  return (
    <div className={styles.container}>
      <div 
        className={`${styles.content} ${isTransitioning ? styles.transitioning : ''}`}
        key={pathname}
      >
        {displayChildren}
      </div>
    </div>
  );
}