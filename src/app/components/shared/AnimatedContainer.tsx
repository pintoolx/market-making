'use client';

import React, { useEffect, useRef, useState } from 'react';
import styles from './AnimatedContainer.module.css';

interface AnimatedContainerProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  animation?: 'fadeIn' | 'slideUp' | 'slideLeft' | 'slideRight' | 'scale';
}

export default function AnimatedContainer({ 
  children, 
  delay = 0, 
  className = '',
  animation = 'fadeIn'
}: AnimatedContainerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            setIsVisible(true);
          }, delay);
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.1 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [delay]);

  return (
    <div 
      ref={ref}
      className={`${styles.container} ${styles[animation]} ${isVisible ? styles.visible : ''} ${className}`}
    >
      {children}
    </div>
  );
}