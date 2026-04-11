/**
 * DropZone.jsx — Drag-and-drop file input component.
 * Accepts DOCX, PPTX, XLSX, and PDF files.
 */

import React, { useState, useRef } from 'react';

const ACCEPTED_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/pdf', // .pdf
];

const ACCEPTED_EXTENSIONS = ['.docx', '.pptx', '.xlsx', '.pdf'];

/**
 * Validate that a File object is of an accepted type.
 * Falls back to extension check since MIME types can differ by OS.
 */
function isAcceptedFile(file) {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(ext);
}

export default function DropZone({ onFilesAdded }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = (fileList) => {
    const valid = Array.from(fileList).filter(isAcceptedFile);
    const invalid = Array.from(fileList).filter((f) => !isAcceptedFile(f));

    if (invalid.length > 0) {
      alert(
        `The following files are not supported and were skipped:\n${invalid.map((f) => f.name).join('\n')}\n\nAccepted formats: DOCX, PPTX, XLSX, PDF`
      );
    }

    if (valid.length > 0) {
      onFilesAdded(valid);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const onDragLeave = () => setIsDragOver(false);

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const onInputChange = (e) => {
    handleFiles(e.target.files);
    // Reset so the same file can be selected again
    e.target.value = '';
  };

  return (
    <div
      className={`dropzone${isDragOver ? ' over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      aria-label="Drop files here or click to browse"
    >
      <div className="dropzone__icon">📂</div>
      <p className="dropzone__text">
        Drag &amp; drop documents here, or <strong>click to browse</strong>
      </p>
      <p className="dropzone__hint">Supported formats: DOCX · PPTX · XLSX · PDF</p>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        style={{ display: 'none' }}
        onChange={onInputChange}
      />
    </div>
  );
}
