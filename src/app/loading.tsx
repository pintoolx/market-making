'use client';

import React from 'react';
import styles from './loading.module.css';
import Image from 'next/image';

export default function Loading() {
  return (
    <div className={styles.container}>
      <Image src="/loading.svg" alt="Loading" className={styles.loadingIcon} width={48} height={48} priority />
    </div>
  );
}