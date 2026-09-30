import React, { useState } from 'react';

interface Photo {
  id: string;
  url: string;
  caption: string;
  uploadedAt: string;
}

export const PhotoGallery: React.FC = () => {
  const [photos, setPhotos] = useState<Photo[]>([
    {
      id: '1',
      url: 'https://via.placeholder.com/300?text=Site+Photo+1',
      caption: 'Initial site preparation',
      uploadedAt: '2023-10-01T08:00:00Z',
    },
    {
      id: '2',
      url: 'https://via.placeholder.com/300?text=Site+Photo+2',
      caption: 'Foundation work',
      uploadedAt: '2023-10-02T10:30:00Z',
    },
  ]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // Mocking file upload
      const newPhoto: Photo = {
        id: Date.now().toString(),
        url: URL.createObjectURL(files[0]),
        caption: 'New uploaded photo',
        uploadedAt: new Date().toISOString(),
      };
      setPhotos([...photos, newPhoto]);
    }
  };

  return (
    <div className="photo-gallery">
      <h2>Report Photos</h2>
      
      <div className="upload-section" style={{ marginBottom: '20px' }}>
        <input 
          type="file" 
          accept="image/*" 
          onChange={handleFileUpload} 
          id="photo-upload"
        />
      </div>

      <div className="photo-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
        {photos.map(photo => (
          <div key={photo.id} className="photo-card" style={{ border: '1px solid #ccc', padding: '8px', borderRadius: '4px' }}>
            <img src={photo.url} alt={photo.caption} style={{ width: '100%', height: 'auto', display: 'block' }} />
            <div style={{ marginTop: '8px' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>{photo.caption}</p>
              <small style={{ color: '#666' }}>{new Date(photo.uploadedAt).toLocaleString()}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
